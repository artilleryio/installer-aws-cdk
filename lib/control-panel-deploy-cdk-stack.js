const { Stack } = require('aws-cdk-lib');

const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const dynamo = require('aws-cdk-lib/aws-dynamodb');
const iam = require('aws-cdk-lib/aws-iam');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const ssm = require('aws-cdk-lib/aws-ssm');

class ControlPanelDeployCdkStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    this.accountId = Stack.of(this).account;
    this.region = Stack.of(this).region;

    const APP_VERSION = typeof process.env.APP_VERSION !== 'undefined' ? process.env.APP_VERSION : 'latest';

    const useTLS = typeof process.env.USE_TLS !== 'undefined';
    const useInternetFacingAlb =
      typeof process.env.USE_INTERNET_FACING_ALB !== 'undefined';

    // Public access requires TLS, which requires an ACM cert
    if (useInternetFacingAlb && !useTLS) {
      throw new Error(
        'Creating an internet-facing deployment requires USE_TLS, APP_DOMAIN and an ACM_CERT_ARN',
      );
    }

    let acmCertArn;
    if (useTLS) {
      if (typeof process.env.ACM_CERT_ARN === 'undefined') {
        throw new Error(
          'An ACM certificate ARN must be provided with ACM_CERT_ARN',
        );
      } else {
        acmCertArn = process.env.ACM_CERT_ARN;
      }
      if (typeof process.env.APP_DOMAIN === 'undefined') {
        throw new Error(
          'APP_DOMAIN must be defined and must match certificate domain (protocol will be added based on USE_TLS value)',
        );
      }
    }

    // TODO: Use a conditional construct to determine whether to create a cluster or not
    const ARTILLERY_CLUSTER_NAME = 'artilleryio-cluster';
    const clusterName =
      process.env.FARGATE_CLUSTER_NAME || ARTILLERY_CLUSTER_NAME;
    const creatingFargateCluster = process.env.CREATE_CLUSTER === 'true';

    let vpc;
    let usingDefaultVpc = false;
    if (typeof process.env.VPC_ID === 'undefined') {
      vpc = ec2.Vpc.fromLookup(this, 'destination-vpc', {
        isDefault: true,
      });
      usingDefaultVpc = true;
    } else {
      vpc = ec2.Vpc.fromLookup(this, 'destination-vpc', {
        vpcId: process.env.VPC_ID,
      });
    }

    let cluster;

    if (creatingFargateCluster) {
      cluster = new ecs.Cluster(this, 'Cluster', {
        enableFargateCapacityProviders: true,
        vpc,
        clusterName,
      });
    } else {
      cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
        clusterName,
      });
    }

    cluster.vpc = vpc;

    console.log(`
Account ID:  ${this.accountId}
Region:      ${this.region}

Cluster:     ${cluster.clusterName} (${
      creatingFargateCluster ? 'will be created' : 'expected to exist'
    })
Cluster VPC: ${cluster.vpc.vpcId}

VPC ID:      ${vpc.vpcId} ${
      usingDefaultVpc ? '(using default VPC as VPC_ID not provided)' : ''
    }
VPC CIDR:    ${vpc.vpcCidrBlock}`);

    const logging = new ecs.AwsLogDriver({
      streamPrefix: 'artillery-control-panel',
    });

    const table = new dynamo.Table(this, 'next-auth', {
      tableName: process.env.AUTH_TABLE_NAME || 'artillery-auth',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      readCapacity: 1,
      writeCapacity: 1,
      partitionKey: {
        name: 'pk',
        type: dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamo.AttributeType.STRING,
      },
      timeToLiveAttribute: 'expires',
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'GSI1PK',
        type: dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI1SK',
        type: dynamo.AttributeType.STRING,
      },
      projectionType: dynamo.ProjectionType.ALL,
      readCapacity: 1,
      writeCapacity: 1,
    });

    //
    // ALB:
    //
    const alb = new elbv2.ApplicationLoadBalancer(this, 'cp-alb', {
      vpc,
      internetFacing: useInternetFacingAlb,
    });

    //
    // Role for CP task:
    //
    const taskRole = new iam.Role(this, 'task-role', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      roleName: `artilleryio-control-panel-task-role-${this.region}`,
      inlinePolicies: {
        DynamoAuthTableAcccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
              ],
              resources: [table.tableArn],
            }),
            new iam.PolicyStatement({
              actions: ['dynamodb:Query', 'dynamodb:Scan'],
              resources: [table.tableArn + '/index/*'],
            }),
          ],
        }),
        ParamStoreAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:DescribeParameters',
                'ssm:GetParametersByPath',
              ],
              resources: [
                `arn:aws:ssm:${this.region}:${this.accountId}:parameter/artilleryio/*`,
              ],
            }),
          ],
        }),
      },
    });
    // Even though AWS refers to both AWS-managed and customer-managed policies as the same thing elsewhere
    // (e.g. in CloudFormation definitions of IAM roles, where both ARNs could go under ManagedPolicyArns),
    // the CDK makes a distinction and requires the use of a separate method to add a customer-managed ARN.
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyArn(
        this,
        'cli-user',
        process.env.CLI_USER_POLICY_ARN_OVERRIDE || `arn:aws:iam::${this.accountId}:policy/artilleryio-cli-user-${this.region}`,
      ),
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      cluster: cluster,
      taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    const appUrl = typeof process.env.APP_DOMAIN !== 'undefined' ? process.env.APP_DOMAIN : alb.loadBalancerDnsName;

    const environment = {
      NEXT_PUBLIC_POSTHOG_KEY:
        'phc_ulEdqYX77EOA7NLzzJot2Hn9vjWLhejn4uTWXpVCYLr',
      API_URL: `${useTLS
        ? 'https://' + appUrl
        : 'http://' + appUrl}`,
      NEXTAUTH_URL: `${useTLS
        ? 'https://' + appUrl
        : 'http://' + appUrl}`,
    };

    if(process.env.ARTILLERY_BACKEND) {
      console.log('\nNOTE: This deployment will be configured as a secondary in region:', process.env.ARTILLERY_BACKEND);
      environment['ARTILLERY_BACKEND'] = process.env.ARTILLERY_BACKEND;
    }

    const secrets = {
      NEXTAUTH_SECRET: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterAttributes(
          this,
          'nextauth-secret',
          { parameterName: '/artilleryio/NEXTAUTH_SECRET' },
        ),
      ),
      GITHUB_CLIENT_ID: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterAttributes(
          this,
          'github-client-id',
          { parameterName: '/artilleryio/GITHUB_CLIENT_ID' },
        ),
      ),
      GITHUB_CLIENT_SECRET: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterAttributes(
          this,
          'github-client-secret',
          { parameterName: '/artilleryio/GITHUB_CLIENT_SECRET' },
        ),
      ),
      GITHUB_ALLOWED_USERS: ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterAttributes(
          this,
          'github-allowed-users',
          { parameterName: '/artilleryio/GITHUB_ALLOWED_USERS' },
        ),
      ),
    };

    taskDefinition.addContainer('artillery-control-panel', {
      image: ecs.ContainerImage.fromRegistry(
        `public.ecr.aws/s5k5j6u0/artillery-dashboard:${APP_VERSION}`,
      ),
      environment: environment,
      portMappings: [{ containerPort: 3000 }, { containerPort: 3001 }],
      secrets,
      logging,
    });

    const service = new ecs.FargateService(this, 'cp-service', {
      cluster,
      cpu: 2048,
      taskDefinition,
      desiredCount: 1,
      memoryLimitMiB: 4096,
      assignPublicIp: true,
    });

    let certificate;
    if (useTLS) {
      alb.addRedirect({
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        sourcePort: 80,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
        targetPort: 443,
      });
      certificate = acm.Certificate.fromCertificateArn(
        this,
        'Certificate',
        acmCertArn,
      );
    }

    new cdk.CfnOutput(this, 'alb-dns-name-output', {
      value: alb.loadBalancerDnsName,
      description: 'DNS name of the ALB that serves Artillery Dashboard',
      exportName: 'AlbDnsName',
    });

    let listenerOpts = {};
    if (useTLS) {
      listenerOpts.protocol = elbv2.ApplicationProtocol.HTTPS;
      listenerOpts.port = 443;
      listenerOpts.certificates = [certificate];
    } else {
      listenerOpts.protocol = elbv2.ApplicationProtocol.HTTP;
      listenerOpts.port = 80;
    }

    const listener = alb.addListener('ui-listener', listenerOpts);

    const target = listener.addTargets('ECS', {
      port: listenerOpts.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: 'artillery-control-panel',
          containerPort: 3000,
        }),
      ],
    });
    target.configureHealthCheck({
      path: '/',
      port: '3000',
      healthyHttpCodes: '200,301,307,308',
    });

    let listener2Opts = {};
    if (useTLS) {
      listener2Opts = Object.assign({}, listenerOpts, {
        port: 8443,
      });
    } else {
      listener2Opts = Object.assign({}, listenerOpts, {
        port: 8000,
      });
    }

    const listener2 = alb.addListener('api-listener', listener2Opts);

    const target2 = listener2.addTargets('ECS-api', {
      port: listener2Opts.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: 'artillery-control-panel',
          containerPort: 3001,
        }),
      ],
    });
    target2.configureHealthCheck({
      path: '/healthz',
    });

    const applicationListenerRule = new elbv2.ApplicationListenerRule(
      this,
      'api-route',
      {
        listener,
        priority: 4,
        action: elbv2.ListenerAction.forward([target2]),
        conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      },
    );

    new elbv2.ApplicationListenerRule(this, 'next-auth-api-route', {
      listener,
      priority: 3,
      action: elbv2.ListenerAction.forward([target]),
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/auth/*'])],
    });
  }
}

module.exports = { ControlPanelDeployCdkStack };
