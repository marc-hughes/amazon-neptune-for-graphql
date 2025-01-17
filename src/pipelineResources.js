/*
Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
Licensed under the Apache License, Version 2.0 (the "License").
You may not use this file except in compliance with the License.
A copy of the License is located at
    http://www.apache.org/licenses/LICENSE-2.0
or in the "license" file accompanying this file. This file is distributed
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
express or implied. See the License for the specific language governing
permissions and limitations under the License.
*/

import { NeptuneClient, 
    DescribeDBClustersCommand, 
    DescribeDBSubnetGroupsCommand  }  from "@aws-sdk/client-neptune";

import { IAMClient, 
    CreateRoleCommand, 
    AttachRolePolicyCommand, 
    GetRoleCommand, 
    CreatePolicyCommand, 
    DetachRolePolicyCommand,
    DeleteRoleCommand,
    DeletePolicyCommand,
    //waitUntilRoleExists, 
    //waitUntilPolicyExists
    }  from "@aws-sdk/client-iam";

import { LambdaClient, 
    CreateFunctionCommand as LambdaCreateFunctionCommand, 
    GetFunctionCommand, 
    DeleteFunctionCommand,
    UpdateFunctionCodeCommand }  from "@aws-sdk/client-lambda";

import { AppSyncClient, 
    CreateGraphqlApiCommand, 
    StartSchemaCreationCommand, 
    CreateDataSourceCommand, 
    CreateFunctionCommand as AppSyncCreateFunctionCommand, 
    CreateResolverCommand,
    CreateApiKeyCommand,
    ListGraphqlApisCommand,
    DeleteGraphqlApiCommand,    
    ListResolversCommand } from "@aws-sdk/client-appsync";

import fs from 'fs';
import archiver from 'archiver';
import ora from 'ora';
import { exit } from "process";
import { parseNeptuneDomainFromHost } from "./util.js";

const NEPTUNE_DB = 'neptune-db';

// Input
let NEPTUNE_DB_NAME = '';
let NAME = '';
let REGION = '';
let APPSYNC_SCHEMA = '';
let SCHEMA_MODEL = null;
let LAMBDA_FILES_PATH = '';
let ADD_MUTATIONS = true;
let quiet = false;
let thisOutputFolderPath = './output';

// Computed
let pipelineExists = false;
let NEPTUNE_HOST = null;
let NEPTUNE_PORT = null;
let NEPTUNE_DBSubnetGroup = null;
let NEPTUNE_DBSubnetIds = [];
let NEPTUNE_VpcSecurityGroupId = null;
let NEPTUNE_IAM_AUTH = false;
let NEPTUNE_CURRENT_VERSION = '';
let NEPTUNE_CURRENT_IAM = false;
let NEPTUNE_IAM_POLICY_RESOURCE = '*';
let LAMBDA_ROLE = '';
let LAMBDA_ARN = '';
let NEPTUNE_TYPE = NEPTUNE_DB;
let ZIP = null;
let RESOURCES = {};
let RESOURCES_FILE = '';


const sleep = ms => new Promise(r => setTimeout(r, ms)); // alternative: import { setTimeout } from timers/promises
let spinner = null;

function yellow(text) {
    return '\x1b[33m' + text + '\x1b[0m';
}


async function checkPipeline() {
    // Checking if Role, Lambda and AppSync API is already created.
    const iamClient = new IAMClient({region: REGION});
    const lambdaClient = new LambdaClient({region: REGION});
    const appSyncClient = new AppSyncClient({region: REGION});

    let lambdaExists = false;
    let appSyncExists = false;
    let roleExists = false;

    if (!quiet) spinner = ora('Checking pipeline resources...').start();
    try {
        const command = new GetFunctionCommand({FunctionName: NAME +'LambdaFunction'});
        await lambdaClient.send(command);
        lambdaExists = true;
    } catch (error) {
        lambdaExists = false;
    }
    
    try {        
        const command = new ListGraphqlApisCommand({apiType: "GRAPHQL"});
        const response = await appSyncClient.send(command);
        response.graphqlApis.forEach(element => {
            if (element.name == NAME + 'API') {
                //APPSYNC_API_ID = element.apiId;                
                appSyncExists = true;
            }
        });
    } catch (error) {
        appSyncExists = false;
    }

    try {
        const command = new GetRoleCommand({ RoleName: NAME + "LambdaExecutionRole" });
        const response = await iamClient.send(command);
        LAMBDA_ROLE = response.Role.Arn;
        roleExists = true;
    } catch (error) {
        roleExists = false;
    }
    
    if (lambdaExists && appSyncExists && roleExists) {
        if (!quiet) spinner.succeed('Pipeline exists.');
        pipelineExists = true;
    } else {
        if (!quiet) spinner.warn('Pipeline does not exists.');
    }

    if (lambdaExists && appSyncExists && roleExists) return;
    if (!lambdaExists && !appSyncExists && !roleExists) return;
    if (!quiet) console.log("One or more pipeline resources are missing.");
    if (!lambdaExists && !quiet) console.log("  Lambda " + NAME + "LambdaFunction" + " is  missing."  );
    if (!roleExists && !quiet) console.log("  Role " + NAME + "LambdaExecutionRole" + " is  missing."  );
    if (!appSyncExists && !quiet) console.log("  AppSync " + NAME + "API" + " is  missing."  );
    console.error("Fix the issue manually or create the pipeline resources with a new name.\n");
    process.exit(1);
}


function storeResource(resource) {
    Object.assign(RESOURCES, resource);  
    fs.writeFileSync(RESOURCES_FILE, JSON.stringify(RESOURCES, null, 2));
}

/**
 * Retrieves information about the neptune db cluster for the given db name and region. Should not be used for neptune analytics graphs.
 */
async function getNeptuneClusterDbInfoBy(name, region) {
    NEPTUNE_DB_NAME = name;
    REGION = region;

    await setNeptuneDbClusterInfo();

    return {
        host: NEPTUNE_HOST, 
        port: NEPTUNE_PORT,
        isIAMauth : NEPTUNE_CURRENT_IAM,
        version : NEPTUNE_CURRENT_VERSION,
        dbSubnetGroup: NEPTUNE_DBSubnetGroup, 
        dbSubnetIds: NEPTUNE_DBSubnetIds, 
        vpcSecurityGroupId: NEPTUNE_VpcSecurityGroupId,
        iamPolicyResource: NEPTUNE_IAM_POLICY_RESOURCE };
}

/**
 * Retrieves information about the neptune db cluster and sets module-level variable values based on response data. Should not be used for neptune analytics graphs.
 */
async function setNeptuneDbClusterInfo() {
    const neptuneClient = new NeptuneClient({region: REGION});

    const params = {
        DBClusterIdentifier: NEPTUNE_DB_NAME
    };

    const data = await neptuneClient.send(new DescribeDBClustersCommand(params));

    const input = { // DescribeDBSubnetGroupsMessage
        DBSubnetGroupName: data.DBClusters[0].DBSubnetGroup,
    };
    const command = new DescribeDBSubnetGroupsCommand(input);
    const response = await neptuneClient.send(command);

    NEPTUNE_HOST = data.DBClusters[0].Endpoint;
    NEPTUNE_PORT = data.DBClusters[0].Port.toString();
    NEPTUNE_DBSubnetGroup = data.DBClusters[0].DBSubnetGroup;
    NEPTUNE_VpcSecurityGroupId = data.DBClusters[0].VpcSecurityGroups[0].VpcSecurityGroupId;
    NEPTUNE_CURRENT_IAM = data.DBClusters[0].IAMDatabaseAuthenticationEnabled;
    NEPTUNE_CURRENT_VERSION = data.DBClusters[0].EngineVersion;
    NEPTUNE_IAM_POLICY_RESOURCE = `${data.DBClusters[0].DBClusterArn.substring(0, data.DBClusters[0].DBClusterArn.lastIndexOf(':cluster')).replace('rds', NEPTUNE_DB)}:${data.DBClusters[0].DbClusterResourceId}/*`;
    response.DBSubnetGroups[0].Subnets.forEach(element => {
        NEPTUNE_DBSubnetIds.push(element.SubnetIdentifier);
    });
}


async function createLambdaRole() {
    const iamClient = new IAMClient({region: REGION});
    
    // Create Lambda principal role
    if (!quiet) spinner = ora('Creating Lambda principal role ...').start();
    const params = {
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: ["lambda.amazonaws.com"] },
              Action: ["sts:AssumeRole"],
            },
          ],
        }),
        RoleName: NAME +"LambdaExecutionRole"
    };
    const data = await iamClient.send(new CreateRoleCommand(params));
    //await waitUntilRoleExists({ client: iamClient, maxWaitTime: 180 }, { RoleName: data.Role.RoleName }); // does not work :(, using sleep
    await sleep(10000);
    LAMBDA_ROLE = data.Role.Arn;
    storeResource({LambdaExecutionRole: NAME +"LambdaExecutionRole"});
    if (!quiet) spinner.succeed('Role ARN: ' + yellow(LAMBDA_ROLE));

    // Attach to Lambda role the AWSLambdaBasicExecutionRole 
    if (!quiet) spinner = ora('Attaching policies to the Lambda principal role ...').start();
    let input = {
        RoleName: NAME +"LambdaExecutionRole",
        PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    };
    let command = new AttachRolePolicyCommand(input);
    await iamClient.send(command);    
    storeResource({LambdaExecutionPolicy1: input.PolicyArn});
    if (!quiet) spinner.succeed(`Attached ${yellow('AWSLambdaBasicExecutionRole')} to Lambda Role`);


    if (NEPTUNE_IAM_AUTH) {

        let action = [];
        if (NEPTUNE_TYPE === NEPTUNE_DB) {
            action = [
                "neptune-db:DeleteDataViaQuery",
                "neptune-db:connect",
                "neptune-db:ReadDataViaQuery",
                "neptune-db:WriteDataViaQuery"
            ];
        } else {
            action = ["neptune-graph:*"]
        }

        // Create Neptune query policy
        if (!quiet) spinner = ora('Creating policy for Neptune queries ...').start();
        let command = new CreatePolicyCommand({
            PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: action,
                    Resource: NEPTUNE_IAM_POLICY_RESOURCE            
                },
            ],
            }),
            PolicyName: NAME+"NeptuneQueryPolicy",
        });
    
        let response = await iamClient.send(command);
        const policyARN = response.Policy.Arn;
        storeResource({NeptuneQueryPolicy: policyARN});
        await sleep(5000);
        if (!quiet) spinner.succeed('Neptune query policy ARN: ' + yellow(policyARN));
        
        // Attach to Lambda role the Neptune query policy. 
        if (!quiet) spinner = ora('Attaching policy for Neptune queries to Lambda role ...').start();
        input = {
            RoleName: NAME +"LambdaExecutionRole",
            PolicyArn: policyARN,
        };
        command = new AttachRolePolicyCommand(input);
        await iamClient.send(command);    
        storeResource({LambdaExecutionPolicy2: input.PolicyArn});    
        await sleep(10000);
        if (!quiet) spinner.succeed(`Attached ${yellow('Neptune Query Policy')} policies to Lambda Role`);
        
    } else {


        if (!quiet) spinner = ora('Attaching policy for Neptune VPC to Lambda role ...').start();
        input = {
            RoleName: NAME +"LambdaExecutionRole",
            PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        };
        command = new AttachRolePolicyCommand(input);
        await iamClient.send(command);    
        storeResource({LambdaExecutionPolicy2: input.PolicyArn});    
        await sleep(10000);
        if (!quiet) spinner.succeed(`Attached ${yellow('AWSLambdaVPCAccessExecutionRole')} policies to role`);
    }

}


async function createDeploymentPackage(folderPath) {       
    const zipFilePath = `${thisOutputFolderPath}/${NAME}.zip`;
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(folderPath, false);
    archive.file(`${thisOutputFolderPath}/output.resolver.graphql.js`, { name: 'output.resolver.graphql.js' })
    await archive.finalize();
    await sleep(2000);
    const fileContent = await fs.readFileSync(zipFilePath);
    return fileContent;    
}


async function createLambdaFunction() {
    if (!quiet) spinner = ora('Creating Lambda function ...').start();

    let params = {
        Code: {
            ZipFile: ZIP
        },
            FunctionName: NAME +'LambdaFunction',
        Handler: 'index.handler',
        Role: LAMBDA_ROLE,
        Runtime: 'nodejs18.x',
        Description: 'Neptune GraphQL Resolver for AppSync',
        Timeout: 15,
        MemorySize: 128,
        Environment: {
            Variables: {
                "NEPTUNE_HOST": NEPTUNE_HOST,
                "NEPTUNE_PORT": NEPTUNE_PORT,
                "NEPTUNE_IAM_AUTH_ENABLED": NEPTUNE_IAM_AUTH.toString(),
                "LOGGING_ENABLED": "false",
                "NEPTUNE_DB_NAME": NEPTUNE_DB_NAME,
                "NEPTUNE_REGION": REGION,
                "NEPTUNE_DOMAIN": parseNeptuneDomainFromHost(NEPTUNE_HOST),
                "NEPTUNE_TYPE": NEPTUNE_TYPE,
            },
        },
    };

    if (!NEPTUNE_IAM_AUTH) {
        params.VpcConfig = {
            SubnetIds: NEPTUNE_DBSubnetIds,
            SecurityGroupIds: [NEPTUNE_VpcSecurityGroupId]
        }
    }
    const lambdaClient = new LambdaClient({region: REGION});
    const data = await lambdaClient.send(new LambdaCreateFunctionCommand(params));
    LAMBDA_ARN = data.FunctionArn;
    storeResource({LambdaFunction: NAME +'LambdaFunction'});
    if (!quiet) spinner.succeed('Lambda Name: ' + yellow(NAME +'LambdaFunction') + ' ARN: ' + yellow(LAMBDA_ARN));
}


async function createAppSyncAPI() {      
    const iamClient = new IAMClient({region: REGION});
    
    if (!quiet) spinner = ora('Creating policy for Lambda invocation ...').start();
    let command = new CreatePolicyCommand({
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
                Effect: "Allow",
                Action: "lambda:invokeFunction",            
                Resource: [
                    LAMBDA_ARN,
                    LAMBDA_ARN + ":*"
                ]            
            },
          ],
        }),
        PolicyName: NAME+"LambdaInvokePolicy",
      }
    );
    let response = await iamClient.send(command);
    const policyARN = response.Policy.Arn;
    storeResource({LambdaInvokePolicy: policyARN});
    if (!quiet) spinner.succeed('Lambda invocation policy ARN: ' + yellow(policyARN));

    let params = {
        AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [                
                {
                    Effect: "Allow",
                    Principal: {
                        Service: "appsync.amazonaws.com"
                    },
                    Action: "sts:AssumeRole"
                }          
            ]
        }),
        RoleName: NAME +"LambdaInvocationRole"
    };

    if (!quiet) spinner = ora('Creating role for Lambda invocation ...').start();
    response = await iamClient.send(new CreateRoleCommand(params));        
    const LAMBDA_INVOCATION_ROLE = response.Role.Arn;        
    storeResource({LambdaInvokeRole: NAME +"LambdaInvocationRole"});
    sleep(5000);
    if (!quiet) spinner.succeed('Lambda invocation role ARN: ' + yellow(LAMBDA_INVOCATION_ROLE));
    
    if (!quiet) spinner = ora('Attaching policy ...').start();
    params = {
        RoleName: NAME +"LambdaInvocationRole",
        PolicyArn: policyARN,
    };
    command = new AttachRolePolicyCommand(params);
    await iamClient.send(command);
    if (!quiet) spinner.succeed('Attached policy to role');

    // APPSync API
    const appSyncClient = new AppSyncClient({region: REGION});

    if (!quiet) spinner = ora('Creating AppSync API ...').start();
    params = {
        name: NAME + 'API',
        authenticationType: "API_KEY",      
        visibility: "GLOBAL",
        apiType: "GRAPHQL"        
    };
    command = new CreateGraphqlApiCommand(params);
    response = await appSyncClient.send(command);
    const apiId = response.graphqlApi.apiId;
    storeResource({AppSyncAPI: apiId});
    if (!quiet) spinner.succeed('Created API id: ' + yellow(apiId) + ' name: ' + yellow(NAME + 'API'));


    // create Key
    if (!quiet) spinner = ora('Creating API key ...').start();
    command = new CreateApiKeyCommand({apiId: apiId});
    response = await appSyncClient.send(command);
    const apiKey = response.apiKey.id;
    if (!quiet) spinner.succeed('Created API key: ' + yellow(apiKey));


    // create datasource
    if (!quiet) spinner = ora('Creating DataSource ...').start();
    params = {
        apiId: apiId,
        name: NAME + 'DataSource',       
        type: "AWS_LAMBDA",
        serviceRoleArn: LAMBDA_INVOCATION_ROLE,
        lambdaConfig: {
            lambdaFunctionArn: LAMBDA_ARN, 
        },
    };    
    command = new CreateDataSourceCommand(params);
    response = await appSyncClient.send(command);
    if (!quiet) spinner.succeed('Created DataSource: ' + yellow(NAME+'DataSource'));


    // create function
    if (!quiet) spinner = ora('Creating Function ...').start();
    params = {
        apiId: apiId,
        name: NAME+'Function',       
        dataSourceName: NAME+'DataSource',
        runtime: {
            name: "APPSYNC_JS",
            runtimeVersion: "1.0.0",
        },
        code:
`import { util } from '@aws-appsync/utils';
export function request(ctx) {
    const {source, args} = ctx
    return {
        operation: 'Invoke',
        payload: {
            field: ctx.info.fieldName, 
            arguments: args,
            selectionSetGraphQL: ctx.info.selectionSetGraphQL,
            source 
        },
    };
}
    
export function response(ctx) {
    return ctx.result;
}`

    };
    command = new AppSyncCreateFunctionCommand(params);
    response = await appSyncClient.send(command);
    await sleep(5000);
    let functionId = response.functionConfiguration.functionId;    
    storeResource({AppSyncAPIFunction: functionId});
    if (!quiet) spinner.succeed('Created Function: ' + yellow(NAME+'Function'));

    // Upload schema
    if (!quiet) spinner = ora('Uploading schema ...').start();
    let encoder = new TextEncoder();
    let definition = encoder.encode(APPSYNC_SCHEMA);
    params = { 
        apiId: apiId,
        definition: definition,
      };
    command = new StartSchemaCreationCommand(params);
    response = await appSyncClient.send(command);    
    await sleep(5000);
    if (!quiet) spinner.succeed('Added schema');
    
    await attachResolvers(appSyncClient, apiId, functionId);
}


async function getSchemaFields(typeName) {
    const r = [];
    SCHEMA_MODEL.definitions.forEach(function (def) {
        if (def.kind == "ObjectTypeDefinition") {
            if (def.name.value == typeName) {    
                def.fields.forEach(function (field) {
                    r.push(field.name.value);
                });
            }
        }   
    });
    return r;
}


async function attachResolvers(client, apiId, functionId) {   
        
    const queries = await getSchemaFields("Query");
    let mutations = [];
    
    if (ADD_MUTATIONS) 
        mutations = await getSchemaFields("Mutation");
    
    let response = null;

    // Queries
    let input = {
        apiId: apiId,
        typeName: "Query",
    };
    let command = new ListResolversCommand(input);
    response = await client.send(command);
    
    let existingQueries = [];
    if (response != null) {
        for (const resolver of response.resolvers) {
            existingQueries.push(resolver.fieldName);
        }
    } 

    for (const query of queries) {
        if (!existingQueries.includes(query)) {                
            await attachResolverToSchemaField(client, apiId, functionId, "Query", query);
        }
    }      
    
    // Mutations    
    if (ADD_MUTATIONS) {
        input = {
            apiId: apiId,
            typeName: "Mutation",
        };
        command = new ListResolversCommand(input);
        response = await client.send(command); 
        
        let existingMutations = [];
        if (response != null) {
            for (const resolver of response.resolvers) {
                existingMutations.push(resolver.fieldName);
            }
        }

        for (const mutation of mutations) {
            if (!existingMutations.includes(mutation)) {                        
                await attachResolverToSchemaField(client, apiId, functionId, "Mutation", mutation);                
            }
        }
    }

}


async function attachResolverToSchemaField (client, apiId, functionId, typeName, fieldName) {
    
    // attach resolvers to schema
    if (!quiet) spinner = ora('Attaching resolver to schema type ' + yellow(typeName) + ' field ' + yellow(fieldName) + ' ...').start();
    const input = {
        apiId: apiId,
        typeName: typeName,
        fieldName: fieldName,    
        kind: "PIPELINE",
        pipelineConfig: {
          functions: [
            functionId
          ],
        },        
        runtime: {
          name: "APPSYNC_JS",
          runtimeVersion: "1.0.0",
        },
        code:
`
import {util} from '@aws-appsync/utils';

export function request(ctx) {
    return {};
}

export function response(ctx) {
    return ctx.prev.result;
}
`,
      };
      const command = new CreateResolverCommand(input);
      await client.send(command);
      await sleep(200);
      if (!quiet) spinner.succeed('Attached resolver to schema type ' + yellow(typeName) + ' field ' + yellow(fieldName));
}


async function removeAWSpipelineResources(resources, quietI) {
    quiet = quietI;
    const appSyncClient = new AppSyncClient({region: resources.region});
    const lambdaClient = new LambdaClient({region: resources.region});
    const iamClient = new IAMClient({region: resources.region});
    
    // Appsync API
    if (!quiet) spinner = ora('Deleting AppSync API ...').start();
    try {
        const input = { 
            apiId:  resources.AppSyncAPI
        };
        const command = new DeleteGraphqlApiCommand(input);
        await appSyncClient.send(command);
        if (!quiet) spinner.succeed('Deleted API id: ' + yellow(resources.AppSyncAPI));
    } catch (error) {
        if (!quiet) spinner.fail('AppSync API delete failed: ' + error);
    }
    
    // Lambda
    if (!quiet) spinner = ora('Deleting Lambda function ...').start();
    try {
        const input = {
            FunctionName: resources.LambdaFunction 
        };
        const command = new DeleteFunctionCommand(input);        
        await lambdaClient.send(command);
        if (!quiet) spinner.succeed('Lambda function deleted: ' + yellow(resources.LambdaFunction));
    } catch (error) {
        if (!quiet) spinner.fail('Lambda function fail to delete: ' + error);
    }    
    
    // Lambda execution role
    if (!quiet) spinner = ora('Detaching IAM policies from role ...').start();
    try {
        let input = { 
            PolicyArn: resources.LambdaExecutionPolicy1,
            RoleName: resources.LambdaExecutionRole
        };
        let command = new DetachRolePolicyCommand(input);        
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Detached policy: ' + yellow(resources.LambdaExecutionPolicy1) + " from role: " + yellow(resources.LambdaExecutionRole));
    } catch (error) {
        if (!quiet) spinner.fail('Detach policy failed: ' + error);
    }

    if (!quiet) spinner = ora('Detaching IAM policies from role ...').start();
    try {
        let input = { 
            PolicyArn: resources.LambdaExecutionPolicy2,
            RoleName: resources.LambdaExecutionRole
        };
        let command = new DetachRolePolicyCommand(input);        
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Detached policy: ' + yellow(resources.LambdaExecutionPolicy2) + " from role: " + yellow(resources.LambdaExecutionRole));
    } catch (error) {
        if (!quiet) spinner.fail('Detach policy failed: ' + error);
    }
    
    // Delete Neptune query Policy
    if (resources.NeptuneQueryPolicy != undefined) {
        if (!quiet) spinner = ora('Deleting policy ...').start();
        try {
            const input = {
                PolicyArn: resources.NeptuneQueryPolicy,
            };
            const command = new DeletePolicyCommand(input);     
            await iamClient.send(command);
            if (!quiet) spinner.succeed('Deleted policy: ' + yellow(resources.NeptuneQueryPolicy));
        } catch (error) {
            if (!quiet) spinner.fail('Delete policy failed: ' + error);
        }
    }

    // Delete Role
    if (!quiet) spinner = ora('Deleting role ...').start();
    try {
        const input = {
            RoleName: resources.LambdaExecutionRole,
        };
        const command = new DeleteRoleCommand(input);        
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Deleted role: ' + yellow(resources.LambdaExecutionRole));
    } catch (error) {
        if (!quiet) spinner.fail('Delete role failed: ' + error);
    }
    
    // AppSync Lambda role
    if (!quiet) spinner = ora('Detaching policy from AppSync Lambda role ...').start();
    try {
        let input = { 
            PolicyArn: resources.LambdaInvokePolicy,
            RoleName: resources.LambdaInvokeRole
        };
        let command = new DetachRolePolicyCommand(input);        
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Detached policy: ' + yellow(resources.LambdaInvokePolicy) + " from role: " + yellow(resources.LambdaInvokeRole));
    } catch (error) {
        if (!quiet) spinner.fail('Detach policy failed: ' + error);
    }

    // Delete Policy
    if (!quiet) spinner = ora('Deleting policy ...').start();
    try {
        const input = {
            PolicyArn: resources.LambdaInvokePolicy,
        };
        const command = new DeletePolicyCommand(input);     
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Deleted policy: ' + yellow(resources.LambdaInvokePolicy));
    } catch (error) {
        if (!quiet) spinner.fail('Delete policy failed: ' + error);
    }
   
    // Delete Role
    if (!quiet) spinner = ora('Deleting role ...').start();
    try {
        const input = {
            RoleName: resources.LambdaInvokeRole,
        };
        const command = new DeleteRoleCommand(input);        
        await iamClient.send(command);
        if (!quiet) spinner.succeed('Deleted role: ' + yellow(resources.LambdaInvokeRole));
    } catch (error) {
        if (!quiet) spinner.fail('Delete role failed: ' + error);
    }    
}


async function updateLambdaFunction(resources) {
    if (!quiet) spinner = ora('Updating Lambda function code ...').start();
    const lambdaClient = new LambdaClient({region: resources.region});
    const input = {
        FunctionName: resources.LambdaFunction,
        ZipFile: ZIP,
    };
    const command = new UpdateFunctionCodeCommand(input);
    await lambdaClient.send(command);
    if (!quiet) spinner.succeed('Lambda function code updated: ' + yellow(resources.LambdaFunction));
}


async function updateAppSyncAPI(resources) {    
    const appSyncClient = new AppSyncClient({region: resources.region});

    if (!quiet) spinner = ora('Updating AppSync API schema ...').start();
    let encoder = new TextEncoder();
    let definition = encoder.encode(APPSYNC_SCHEMA);

    let params = { 
        apiId: resources.AppSyncAPI,
        definition: definition,
      };
    let command = new StartSchemaCreationCommand(params);
    await appSyncClient.send(command);    
    await sleep(5000);
    if (!quiet) spinner.succeed('Schema updated');
  
    await attachResolvers(appSyncClient, resources.AppSyncAPI, resources.AppSyncAPIFunction);
}


async function createUpdateAWSpipeline (    pipelineName,
                                            neptuneDBName,
                                            neptuneDBregion,
                                            appSyncSchema,
                                            schemaModel,
                                            lambdaFilesPath,
                                            addMutations,
                                            quietI,
                                            __dirname,
                                            isNeptuneIAMAuth,
                                            neptuneHost,
                                            neptunePort,
                                            outputFolderPath,
                                            neptuneType) {

    NAME = pipelineName;
    REGION = neptuneDBregion;
    NEPTUNE_DB_NAME = neptuneDBName;
    APPSYNC_SCHEMA = appSyncSchema;
    SCHEMA_MODEL = schemaModel;
    LAMBDA_FILES_PATH = lambdaFilesPath;
    RESOURCES_FILE = `${outputFolderPath}/${NAME}-resources.json`;
    ADD_MUTATIONS = addMutations;
    quiet = quietI;
    NEPTUNE_IAM_AUTH = isNeptuneIAMAuth;
    NEPTUNE_HOST = neptuneHost;
    NEPTUNE_PORT = neptunePort;
    thisOutputFolderPath = outputFolderPath;
    NEPTUNE_TYPE = neptuneType;

    if (!quiet) console.log('\nCheck if the pipeline resources have been created');
    await checkPipeline();

    if (!pipelineExists) {
        try {
            storeResource({region: REGION});

            if (NEPTUNE_TYPE === NEPTUNE_DB) {
                try {
                    if (!quiet) console.log('Get Neptune Cluster Info');
                    if (!quiet) spinner = ora('Getting ...').start();
                    await setNeptuneDbClusterInfo();
                    if (!quiet) spinner.succeed('Got Neptune Cluster Info');
                    if (isNeptuneIAMAuth) {
                        if (!NEPTUNE_CURRENT_IAM) {
                            console.error("The Neptune database authentication is set to VPC.");
                            console.error("Remove the --create-update-aws-pipeline-neptune-IAM option.");
                            exit(1);
                        }
                    } else {
                        if (NEPTUNE_CURRENT_IAM) {
                            console.error("The Neptune database authentication is set to IAM.");
                            console.error("Add the --create-update-aws-pipeline-neptune-IAM option.");
                            exit(1);
                        } else {
                            if (!quiet) console.log(`Subnet Group: ` + yellow(NEPTUNE_DBSubnetGroup));
                        }
                    }

                    if (NEPTUNE_CURRENT_VERSION != '') {
                        const v = NEPTUNE_CURRENT_VERSION;
                        if (lambdaFilesPath.includes('SDK') == true &&
                            (v == '1.2.1.0' || v == '1.2.0.2' || v == '1.2.0.1' || v == '1.2.0.0' || v == '1.1.1.0' || v == '1.1.0.0')) {
                            console.error("Neptune SDK query is supported starting with Neptune versions 1.2.2.0");
                            console.error("Switch to Neptune HTTPS query with option --output-resolver-query-https");
                            exit(1);
                        }
                    }

                } catch (error) {
                    if (!quiet) spinner.fail("Error getting Neptune Cluster Info.");
                    if (!isNeptuneIAMAuth) {
                        console.error("VPC data is not available to proceed.");
                        exit(1);
                    } else {
                        if (!quiet) console.log("Could not read the database ARN to restrict the Lambda permissions. \nTo increase security change the resource in the Neptune Query policy.")
                        if (!quiet) console.log("Proceeding without getting Neptune Cluster info.");
                    }
                }
            }
            if (!quiet) console.log('Create ZIP');
            if (!quiet) spinner = ora('Creating ZIP ...').start();
            ZIP = await createDeploymentPackage(LAMBDA_FILES_PATH)
            if (!quiet) spinner.succeed('Created ZIP File: ' + yellow(LAMBDA_FILES_PATH));

            if (!quiet) console.log('Create Lambda execution role');
            await createLambdaRole();            

            if (!quiet) console.log('Create Lambda function');
            await createLambdaFunction();            

            if (!quiet) console.log('Create AppSync API');
            await createAppSyncAPI();            

            if (!quiet) console.log('Saved resorces to file: ' + yellow(RESOURCES_FILE));

        } catch (error) {
            if (!quiet) spinner.fail('Error creating resources: ' + error);
            console.error('Rolling back resources.');
            await removeAWSpipelineResources(RESOURCES, quiet);
            return;
        }

    } else {
        if (!quiet) console.log('Update resources');
        let resources = null;
        try {
            if (!quiet) spinner = ora('Loading resources file ...').start();
            resources = JSON.parse(fs.readFileSync(RESOURCES_FILE, 'utf8'));
            if (!quiet) spinner.succeed('Loaded resources from file: ' + yellow(RESOURCES_FILE));
        } catch (error) {
            if (!quiet) spinner.warn('Error loading resources file: ' + RESOURCES_FILE + ' ' + error);
            return;
        }  
        
        if (!quiet) console.log('Create ZIP');
        if (!quiet) spinner = ora('Creating ZIP ...').start();
        ZIP = await createDeploymentPackage(LAMBDA_FILES_PATH)
        if (!quiet) spinner.succeed('File: ' + yellow(LAMBDA_FILES_PATH));

        if (!quiet) console.log('Update Lambda function');
        await updateLambdaFunction(resources);

        if (!quiet) console.log('Update AppSync API');
        await updateAppSyncAPI(resources);
    }
}

export { createUpdateAWSpipeline, getNeptuneClusterDbInfoBy, removeAWSpipelineResources }

