import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class CloudWatchAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const keyPairName = "MyKeyPair";
    const versions = [
      "1.4.37882", // Good
      "1.4.37884", // Bad
      "1.4.37884-2-unsigned", // Good
      "latest" // Good Luck
    ];

    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      availabilityZones: [
        `${cdk.Aws.REGION}a`
      ],
      publicSubnetIds: [
        cdk.Fn.importValue("DmzPubASubnetId")
      ],
      vpcId: cdk.Fn.importValue("VpcId")
    });

    const bucket = new s3.Bucket(this, "Bucket", {
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const bucketDeployment = new s3deploy.BucketDeployment(this, "BucketDeployment", {
      destinationBucket: bucket,
      memoryLimit: 512,
      sources: [
        s3deploy.Source.asset("assets")
      ]
    });

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy")
      ]
    });
    bucket.grantRead(role);

    const securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      allowAllOutbound: true,
      securityGroupName: cdk.Aws.STACK_NAME,
      vpc: vpc
    });
    cdk.Tags.of(securityGroup).add('Name', cdk.Aws.STACK_NAME);
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing());
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3389));

    const logicalIdSuffix = new Date().toISOString();
    versions.forEach(version => {
      var userData = ec2.UserData.forWindows();

      userData.addCommands(
        "$ErrorActionPreference = 'Stop'",
        `Start-Transcript -Path "C:\\UserDataTranscript.$(Get-Date -Format 'yyyyMMdd-HHmmss').log"`,
      );

      userData.addS3DownloadCommand({
        bucket: bucketDeployment.deployedBucket,
        bucketKey: "amazon-cloudwatch-agent.json",
        localFile: "C:\\amazon-cloudwatch-agent.json"
      });

      if (version === "latest") {
        userData.addCommands(
          "[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13",
          `Invoke-WebRequest -UseBasicParsing -Uri 'https://s3.${cdk.Aws.REGION}.amazonaws.com/amazoncloudwatch-agent-${cdk.Aws.REGION}/windows/amd64/latest/amazon-cloudwatch-agent.msi' -OutFile 'C:\\amazon-cloudwatch-agent.msi'`
        );
      } else {
        userData.addS3DownloadCommand({
          bucket: bucketDeployment.deployedBucket,
          bucketKey: `amazon-cloudwatch-agent-${version}.msi`,
          localFile: "C:\\amazon-cloudwatch-agent.msi"
        });
      }

      userData.addCommands(
        'Write-Host "Installing C:\\amazon-cloudwatch-agent.msi"',
        '$params = @{',
        '  "FilePath" = "$Env:SystemRoot\\System32\\msiexec.exe"',
        '  "ArgumentList" = @(',
        '    "/i"',
        '    "C:\\amazon-cloudwatch-agent.msi"',
        '    "/norestart"',
        '    "/quiet"',
        '    "/L*V"',
        '    "C:\\msiexec.log"',
        '  )',
        '  "Verb" = "runas"',
        '  "PassThru" = $true',
        '}',
        '$process = Start-Process @params',
        '$process.WaitForExit()',
        'if ($process.ExitCode -ne 0) { throw new Error("Process exited with $($process.ExitCode)") }',
        'Write-Host "Installed C:\\amazon-cloudwatch-agent.msi"',
      );

      userData.addCommands(
        "Write-Host $(& 'C:\\Program Files\\Amazon\\AmazonCloudWatchAgent\\amazon-cloudwatch-agent.exe' --version)"
      );

      userData.addCommands(
        'Write-Host "Configuring CloudWatchAgent"',
        "& 'C:\\Program Files\\Amazon\\AmazonCloudWatchAgent\\amazon-cloudwatch-agent-ctl.ps1' -a fetch-config -m ec2 -s -c file:C:\\amazon-cloudwatch-agent.json",
        'Write-Host "Configured CloudWatchAgent"',
      );

      userData.addCommands(
        'Write-Host "Reached the end of UserData."'
      );

      const instance = new ec2.Instance(this, `Instance-${version}-${logicalIdSuffix}`, {
        associatePublicIpAddress: true,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
        keyName: keyPairName,
        machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base'),
        role: role,
        securityGroup: securityGroup,
        userData: userData,
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC
        }
      });
      cdk.Tags.of(instance).add('Name', `CloudWatchAgent-${version}`);
    });
  }
}
