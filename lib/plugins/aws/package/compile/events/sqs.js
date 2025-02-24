'use strict';

const _ = require('lodash');
const resolveLambdaTarget = require('../../../utils/resolveLambdaTarget');

class AwsCompileSQSEvents {
  constructor(serverless) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');

    this.hooks = {
      'package:compileEvents': this.compileSQSEvents.bind(this),
    };

    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'sqs', {
      anyOf: [
        { $ref: '#/definitions/awsArn' },
        {
          type: 'object',
          properties: {
            arn: { $ref: '#/definitions/awsArn' },
            batchSize: { type: 'integer', minimum: 1, maximum: 10000 },
            enabled: { type: 'boolean' },
            maximumBatchingWindow: { type: 'integer', minimum: 0, maximum: 300 },
            functionResponseType: { enum: ['ReportBatchItemFailures'] },
          },
          required: ['arn'],
          additionalProperties: false,
        },
      ],
    });
  }

  compileSQSEvents() {
    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName);

      if (functionObj.events) {
        const sqsStatement = {
          Effect: 'Allow',
          Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
          Resource: [],
        };

        functionObj.events.forEach((event) => {
          if (event.sqs) {
            let EventSourceArn;
            let BatchSize = 10;
            let Enabled = true;

            if (typeof event.sqs === 'object') {
              EventSourceArn = event.sqs.arn;
              BatchSize = event.sqs.batchSize || BatchSize;
              if (typeof event.sqs.enabled !== 'undefined') {
                Enabled = event.sqs.enabled;
              }
            } else if (typeof event.sqs === 'string') {
              EventSourceArn = event.sqs;
            }

            const queueName = (function () {
              if (EventSourceArn['Fn::GetAtt']) {
                return EventSourceArn['Fn::GetAtt'][0];
              } else if (EventSourceArn['Fn::ImportValue']) {
                return EventSourceArn['Fn::ImportValue'];
              } else if (EventSourceArn['Fn::Join']) {
                // [0] is the used delimiter, [1] is the array with values
                return EventSourceArn['Fn::Join'][1].slice(-1).pop();
              }
              return EventSourceArn.split(':').pop();
            })();

            const queueLogicalId = this.provider.naming.getQueueLogicalId(functionName, queueName);

            const dependsOn = [];
            const functionIamRoleResourceName =
              this.provider.resolveFunctionIamRoleResourceName(functionObj);
            if (functionIamRoleResourceName) {
              dependsOn.push(functionIamRoleResourceName);
            }
            const { targetAlias } = this.serverless.service.functions[functionName];
            if (targetAlias) {
              dependsOn.push(targetAlias.logicalId);
            }

            const sqsTemplate = {
              Type: 'AWS::Lambda::EventSourceMapping',
              DependsOn: dependsOn,
              Properties: {
                BatchSize,
                MaximumBatchingWindowInSeconds:
                  event.sqs.maximumBatchingWindow != null
                    ? event.sqs.maximumBatchingWindow
                    : undefined,
                EventSourceArn,
                FunctionName: resolveLambdaTarget(functionName, functionObj),
                Enabled,
              },
            };

            if (event.sqs.functionResponseType != null) {
              sqsTemplate.Properties.FunctionResponseTypes = [event.sqs.functionResponseType];
            }

            // add event source ARNs to PolicyDocument statements
            sqsStatement.Resource.push(EventSourceArn);

            const newSQSObject = {
              [queueLogicalId]: sqsTemplate,
            };

            _.merge(
              this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
              newSQSObject
            );
          }
        });

        // update the PolicyDocument statements (if default policy is used)
        if (
          this.serverless.service.provider.compiledCloudFormationTemplate.Resources
            .IamRoleLambdaExecution
        ) {
          const statement =
            this.serverless.service.provider.compiledCloudFormationTemplate.Resources
              .IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement;
          if (sqsStatement.Resource.length) {
            statement.push(sqsStatement);
          }
        }
      }
    });
  }
}

module.exports = AwsCompileSQSEvents;
