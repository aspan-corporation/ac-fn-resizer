import { QueueLambdaConstruct } from "@aspan-corporation/ac-shared-cdk";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

export class AcFnResizerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sharpLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/layers/sharp/arn"
    );

    // Get centralized log group from monitoring stack
    const centralLogGroupArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/monitoring/central-log-group-arn"
    );
    const centralLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "CentralLogGroup",
      centralLogGroupArn
    );

    // Create the Queue + Lambda construct for image resizing
    const resizerProcessor = new QueueLambdaConstruct(
      this,
      "ResizerProcessor",
      {
        entry: path.join(currentDirPath, "../src/resizer/app.ts"),
        handler: "handler",
        logGroup: centralLogGroup,
        memorySize: 2048,
        timeout: cdk.Duration.seconds(400),
        batchSize: 1,
        maxReceiveCount: 3,
        reservedConcurrentExecutions: 10,
        layers: [
          lambda.LayerVersion.fromLayerVersionArn(
            this,
            "SharpLayer",
            sharpLayerArn
          )
        ],
        nodejsOptions: {
          bundling: {
            externalModules: ["sharp"],
            target: "es2022"
          }
        },
        environment: {
          LOG_LEVEL: "INFO",
          POWERTOOLS_SERVICE_NAME: "ac-fn-resizer",
          DESTINATION_BUCKET_NAME: ssm.StringParameter.valueForStringParameter(
            this,
            "/ac/storage/thumbs-bucket-name"
          ),
          LD_LIBRARY_PATH:
            "/opt/lib:/var/lang/lib:/lib64:/usr/lib64:/var/runtime:/var/runtime/lib:/var/task:/var/task/lib",
          VIPSHOME: "/opt",
          AC_IDEMPOTENCY_TABLE_NAME:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/data/idempotency-table-name"
            ),
          AC_TAU_MEDIA_META_TABLE_NAME:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/data/meta-table-name"
            ),
          AC_TAU_MEDIA_MEDIA_BUCKET_ACCESS_ROLE_ARN:
            ssm.StringParameter.valueForStringParameter(
              this,
              "/ac/iam/media-bucket-access-role-arn"
            )
        }
      }
    );

    const idempotencyTableName = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/data/idempotency-table-name"
    );

    const idempotencyTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${idempotencyTableName}`
      },
      this
    );

    const metaTableNameResolved = "AcDataStack-metadata";
    const metaTableArn = cdk.Arn.format(
      {
        partition: "aws",
        service: "dynamodb",
        region: this.region,
        account: this.account,
        resource: `table/${metaTableNameResolved}`
      },
      this
    );

    resizerProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:ConditionCheckItem"
        ],
        resources: [idempotencyTableArn]
      })
    );

    resizerProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:DescribeTable"],
        resources: [metaTableArn]
      })
    );

    // Allow Lambda to assume the S3 media read access role
    resizerProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/aspan-corporation/ac-s3-media-read-access`
        ]
      })
    );

    // Allow Lambda to put objects to thumbs bucket
    const thumbsBucketArn = ssm.StringParameter.valueForStringParameter(
      this,
      "/ac/storage/thumbs-bucket-arn"
    );

    resizerProcessor.processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${thumbsBucketArn}/*`]
      })
    );

    // Store the queue URL in SSM Parameter Store for external access
    new ssm.StringParameter(this, "ResizerProcessorQueueUrlParameter", {
      parameterName: "/ac/resizer/queue-url",
      stringValue: resizerProcessor.queue.queueUrl
    });
  }
}
