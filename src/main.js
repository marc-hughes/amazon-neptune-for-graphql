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

import { readFileSync, writeFileSync, mkdirSync}  from 'fs';
import { helpTxt }  from './help.js';
import { graphDBInferenceSchema } from './graphdb.js';
import { changeGraphQLSchema } from './changes.js';
import { schemaParser, schemaStringify } from './schemaParser.js';
import { validatedSchemaModel} from './schemaModelValidator.js';
import { resolverJS } from './resolverJS.js';
import { getNeptuneSchema, setGetNeptuneSchemaParameters } from './NeptuneSchema.js';
import { createUpdateAWSpipeline, removeAWSpipelineResources } from './pipelineResources.js'
import { createAWSpipelineCDK } from './CDKPipelineApp.js'
import { createLambdaDeploymentPackage } from './lambdaZip.js'

import ora from 'ora';
let spinner = null;
function yellow(text) {
    return '\x1b[33m' + text + '\x1b[0m';
}

// find global installation dir
import path from 'path';
import { fileURLToPath } from 'url';
import { parseNeptuneDomainFromEndpoint } from "./util.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// get version
const version = JSON.parse(readFileSync(__dirname + '/../package.json')).version;

/**
 * neptune-graph is neptune analytics
 */
const NEPTUNE_GRAPH = 'neptune-graph';
const NEPTUNE_DB = 'neptune-db';

// Input
let quiet = false;
let inputGraphQLSchema = '';
let inputGraphQLSchemaFile = '';
let inputGraphQLSchemaChanges = '';
let inputGraphQLSchemaChangesFile = '';
let inputGraphDBSchema = '';
let inputGraphDBSchemaFile = '';
let inputGraphDBSchemaNeptuneEndpoint = '';
let queryLanguage = 'opencypher'; // or TODO 'gremlin' or 'sparql'
let queryClient = 'sdk';          // or 'http'
let isNeptuneIAMAuth = false;
let createUpdatePipeline = false;
let createUpdatePipelineName = '';
let createUpdatePipelineEndpoint = '';
let createUpdatePipelineRegion = 'us-east-1';
let createUpdatePipelineNeptuneDatabaseName = '';
let removePipelineName = '';
let inputCDKpipeline = false;
let inputCDKpipelineName = '';
let inputCDKpipelineEnpoint = '';
let inputCDKpipelineFile = '';
let inputCDKpipelineRegion = '';
let inputCDKpipelineDatabaseName = '';
let createLambdaZip = true;
let outputFolderPath = './output';
let neptuneType = NEPTUNE_DB; // or neptune-graph

// Outputs
let outputSchema = '';
let outputSchemaFile = '';
let outputSourceSchema = '';
let outputSourceSchemaFile = '';
let outputSchemaMutations = true;
let outputLambdaResolver  = '';
let outputLambdaResolverFile  = '';
let outputJSResolver  = '';
let outputJSResolverFile  = '';
let outputNeptuneSchemaFile = '';
let outputLambdaResolverZipName = '';
let outputLambdaResolverZipFile = '';
let outputLambdaPackagePath = '';

// Schema model
let schemaModel = {};

// Parse input arguments
function processArgs() {
    process.argv.forEach(function (val, index, array) {
        switch(val) {
            case '--help':
            case '--h':
            case '-help':
            case '-h':
                console.log(helpTxt);
                process.exit(0);
            break;
            case '--version':
            case '--v':
            case '-version':
            case '-v':
                console.log(version);
                process.exit(0);
            break;
            case '-q':
            case '--quiet':
                quiet = true;
            break;
            case '-is':
            case '--input-schema':
                inputGraphQLSchema = array[index + 1];
            break;
            case '-isf':
            case '--input-schema-file':
                inputGraphQLSchemaFile = array[index + 1];
            break;
            case '-ig':
            case '--input-graphdb-schema':
                inputGraphDBSchema = array[index + 1];
            break;
            case '-igf':
            case '--input-graphdb-schema-file':
                inputGraphDBSchemaFile = array[index + 1];
            break;
            case '-isc':
            case '--input-schema-changes-file':
                inputGraphQLSchemaChangesFile = array[index + 1];
            break;
            case '-ie':
            case '--input-graphdb-schema-neptune-endpoint':
                inputGraphDBSchemaNeptuneEndpoint = array[index + 1];
            break;
            case '-os':
            case '--output-schema-file':
                outputSchemaFile = array[index + 1];
            break;
            case '-oss':
            case '--output-source-schema-file':
                outputSourceSchemaFile = array[index + 1];
            break;
            case '-onm':
            case '--output-schema-no-mutations':
                outputSchemaMutations = false;
            break;
            case '-olr':
            case '--output-lambda-resolver-file':
                outputLambdaResolverFile = array[index + 1];
            break;
            case '-or':
            case '--output-js-resolver-file':
                outputJSResolverFile = array[index + 1];
            break;
            case '-og':
            case '--output-neptune-schema-file':
                outputNeptuneSchemaFile = array[index + 1];
            break;
            case '-org':
            case '--output-resolver-query-gremlin':
                queryLanguage = 'gremlin';
            break;
            case '-oro':
            case '--output-resolver-query-opencypher':
                queryLanguage = 'opencypher';
            break;
            case '-orc':
            case '--output-resolver-query-client':
                queryClient = 'client';
            break;
            case '-orh':
            case '--output-resolver-query-https':
                queryClient = 'http';
            break;
            case '-ors':
            case '--output-resolver-query-sdk':
                queryClient = 'sdk';
            break;
            case '-p':
            case '--create-update-aws-pipeline':
                createUpdatePipeline = true;
            break;
            case '-pn':
            case '--create-update-aws-pipeline-name':
                createUpdatePipelineName = array[index + 1];
            break;
            case '-pr':
            case '--create-update-aws-pipeline-region':
                createUpdatePipelineRegion = array[index + 1];
            break;
            case '-pe':
            case '--create-update-aws-pipeline-neptune-endpoint':
                createUpdatePipelineEndpoint = array[index + 1];
            break;
            case '-pd':
            case '--create-update-aws-pipeline-neptune-database-name':
                createUpdatePipelineNeptuneDatabaseName = array[index + 1];
            break;
            case '-rp':
            case '--remove-aws-pipeline-name':
                removePipelineName = array[index + 1];
            break;
            case '-c':
            case '--output-aws-pipeline-cdk':
                inputCDKpipeline = true;            
            break;
            case '-ce':
            case '--output-aws-pipeline-cdk-neptune-endpoint':
                inputCDKpipelineEnpoint = array[index + 1];
            break;
            case '-cd':
            case '--output-aws-pipeline-cdk-neptune-database-name':
                inputCDKpipelineDatabaseName = array[index + 1];
            break;
            case '-cn':
            case '--output-aws-pipeline-cdk-name':
                inputCDKpipelineName = array[index + 1];
            break;
            case '-cr':
            case '--output-aws-pipeline-cdk-region':
                inputCDKpipelineRegion = array[index + 1];
            break;
            case '-cf':
            case '--output-aws-pipeline-cdk-file':
                inputCDKpipelineFile = array[index + 1];
            break;
            case '-oln':
            case '--output-lambda-resolver-zip-name':
                outputLambdaResolverZipName = array[index + 1];
            break;
            case '-olf':
            case '--output-lambda-resolver-zip-file':
                outputLambdaResolverZipFile = array[index + 1];
            break;
            case '-pi':
            case '--create-update-aws-pipeline-neptune-IAM':
                isNeptuneIAMAuth = true;
            break;
            case '-ci':
            case '--output-aws-pipeline-cdk-neptune-IAM':
                isNeptuneIAMAuth = true;
            break;
            case '-onl':
            case '--output-no-lambda-zip':
                createLambdaZip = false;
            break;
            case '-o':
            case '--output-folder-path':
                outputFolderPath = array[index + 1];
            break;
        }
    });

}

async function main() {
    
    if (process.argv.length <= 2) {
        console.log("--h for help.\n");
        process.exit(0);
    }

    processArgs();

    // Get graphDB schema from file
    if (inputGraphDBSchemaFile != '' && inputGraphQLSchema == '' && inputGraphQLSchemaFile == '') {
        try {
            inputGraphDBSchema = readFileSync(inputGraphDBSchemaFile, 'utf8');
            if (!quiet) console.log('Loaded graphDB schema from file: ' + inputGraphDBSchemaFile);
        } catch (err) {
            console.error('Error reading graphDB schema file: ' + inputGraphDBSchemaFile);
            process.exit(1);
        }
    }

    // Check if any of the Neptune endpoints are a neptune analytic endpoint and if so, set the neptuneType and IAM to required
    const nonEmptyEndpoints = [inputGraphDBSchemaNeptuneEndpoint, createUpdatePipelineEndpoint, inputCDKpipelineEnpoint].filter(endpoint => endpoint !== '');
    const isNeptuneAnalyticsGraph = nonEmptyEndpoints.length > 0 && parseNeptuneDomainFromEndpoint(nonEmptyEndpoints[0]).includes(NEPTUNE_GRAPH);
    if (isNeptuneAnalyticsGraph) {
        neptuneType = NEPTUNE_GRAPH;
        // neptune analytics requires IAM
        console.log("Detected neptune-graph from input endpoint - setting IAM auth to true as it is required for neptune analytics")
        isNeptuneIAMAuth = true;
    }

    // Get Neptune schema from endpoint
    if (inputGraphDBSchemaNeptuneEndpoint != '' && inputGraphDBSchema == '' && inputGraphDBSchemaFile == '') {
        let endpointParts = inputGraphDBSchemaNeptuneEndpoint.split(':');
        if (endpointParts.length !== 2) {
            console.error('Neptune endpoint must be in the form of host:port');
            process.exit(1);
        }
        let neptuneHost = endpointParts[0];
        let neptunePort = endpointParts[1];
        
        let neptuneRegionParts = inputGraphDBSchemaNeptuneEndpoint.split('.');
        let neptuneRegion = '';
        if (neptuneType === NEPTUNE_DB)
            neptuneRegion = neptuneRegionParts[2];
        else
            neptuneRegion = neptuneRegionParts[1];

        if (!quiet) console.log('Getting Neptune schema from endpoint: ' + yellow(neptuneHost + ':' + neptunePort));
        setGetNeptuneSchemaParameters(neptuneHost, neptunePort, neptuneRegion, true, neptuneType);
        let startTime = performance.now();
        inputGraphDBSchema = await getNeptuneSchema(quiet);
        let endTime = performance.now();
        let executionTime = endTime - startTime;
        if (!quiet) console.log(`Execution time: ${(executionTime/1000).toFixed(2)} seconds`);
        if (!quiet) console.log('');
    }

    // Option 2: inference GraphQL schema from graphDB schema
    if (inputGraphDBSchema != '' && inputGraphQLSchema == '' && inputGraphQLSchemaFile == '') {
        if (!quiet) console.log('Inferencing GraphQL schema from graphDB schema');
        inputGraphQLSchema = graphDBInferenceSchema(inputGraphDBSchema, outputSchemaMutations);
        if (!quiet) console.log('');
    }

    // Option 1: load
    if (inputGraphQLSchema == '' && inputGraphQLSchemaFile != '') {
        try {
            inputGraphQLSchema = readFileSync(inputGraphQLSchemaFile, 'utf8');
            if (!quiet) console.log('Loaded GraphQL schema from file: ' + inputGraphQLSchemaFile);
        } catch (err) {
            console.error('Error reading GraphQL schema file: ' + inputGraphQLSchemaFile);
            process.exit(1);
        }    
    }

    // Changes
    if (inputGraphQLSchemaChangesFile != '') {
        try {
            inputGraphQLSchemaChanges = readFileSync(inputGraphQLSchemaChangesFile, 'utf8');
            if (!quiet) console.log('Loaded GraphQL schema changes from file: ' + inputGraphQLSchemaChangesFile);
        } catch (err) {
            console.error('Error reading GraphQL schema changes file: ' + inputGraphQLSchemaChangesFile);
            process.exit(1);
        }    
    }

    // AWS pipeline
    if (createUpdatePipeline) {
        if (!inputGraphDBSchemaNeptuneEndpoint == '' && createUpdatePipelineEndpoint == '') {
            createUpdatePipelineEndpoint = inputGraphDBSchemaNeptuneEndpoint;
        }
        if (createUpdatePipelineEndpoint == '' &&
            createUpdatePipelineRegion == '' && createUpdatePipelineNeptuneDatabaseName == '') {
            console.error('AWS pipeline: is required a Neptune endpoint, or a Neptune database name and region.');
            process.exit(1);
        }
        if (createUpdatePipelineEndpoint == '' &&
            !createUpdatePipelineRegion == '' && createUpdatePipelineNeptuneDatabaseName == '') {
            console.error('AWS pipeline: a Neptune database name is required.');
            process.exit(1);
        }
        if (createUpdatePipelineEndpoint == '' &&
            createUpdatePipelineRegion == '' && !createUpdatePipelineNeptuneDatabaseName == '') {
            console.error('AWS pipeline: a Neptune database region is required.');
            process.exit(1);
        }
        if (createUpdatePipelineEndpoint != '') {
            let parts = createUpdatePipelineEndpoint.split('.');
            createUpdatePipelineNeptuneDatabaseName = parts[0];

            let parsedRegion;
            if (neptuneType === NEPTUNE_DB) {
                parsedRegion = parts[2];
            } else {
                parsedRegion = parts[1];
            }

            if (createUpdatePipelineRegion !== parsedRegion) {
                if (createUpdatePipelineRegion !== '') {
                    console.log('Switching region from ' + createUpdatePipelineRegion + ' to region parsed from endpoint: ' + parsedRegion);
                } else {
                    console.log('Region parsed from endpoint: ' + parsedRegion);
                }
                createUpdatePipelineRegion = parsedRegion;
            }
        }
        if (createUpdatePipelineName == '') {
            createUpdatePipelineName = createUpdatePipelineNeptuneDatabaseName;
        }
    }   

    // CDK
    if (inputCDKpipeline) {
        if (!inputGraphDBSchemaNeptuneEndpoint == '') {
            inputCDKpipelineEnpoint = inputGraphDBSchemaNeptuneEndpoint;
        }
        if (inputCDKpipelineEnpoint == '' &&
            inputCDKpipelineRegion == '' && inputCDKpipelineDatabaseName == '') {
            console.error('AWS CDK: is required a Neptune endpoint, or a Neptune database name and region.');
            process.exit(1);
        }
        if (inputCDKpipelineEnpoint == '' &&
            !inputCDKpipelineRegion == '' && inputCDKpipelineDatabaseName == '') {
            console.error('AWS CDK: a Neptune database name is required.');
            process.exit(1);
        }
        if (inputCDKpipelineEnpoint == '' &&
            inputCDKpipelineRegion == '' && !inputCDKpipelineDatabaseName == '') {
            console.error('AWS CDK: a Neptune database region is required.');
            process.exit(1);
        }    
        if (inputCDKpipelineEnpoint != '') {
            let parts = inputCDKpipelineEnpoint.split('.');
            inputCDKpipelineDatabaseName = parts[0];
            inputCDKpipelineRegion = parts[2];
        }
        if (inputCDKpipelineName == '') {
            inputCDKpipelineName = inputCDKpipelineDatabaseName;
        }
    }

    // Apply changes
    if (inputGraphQLSchemaChanges != '') {
        inputGraphQLSchema = changeGraphQLSchema(inputGraphQLSchema, inputGraphQLSchemaChanges); 
    }

    if (inputGraphQLSchema != '') {
        // Parse schema
        schemaModel = schemaParser(inputGraphQLSchema);
        
        // Validate schema
        schemaModel = validatedSchemaModel(schemaModel, quiet);

        // Generate AWS Lambda resolver for AppSync and Amazon Neptune        
        outputLambdaResolver = resolverJS(schemaModel, queryLanguage, queryClient, __dirname);

        // Generate generic Javascript resolver
        outputJSResolver = resolverJS(schemaModel, queryLanguage, queryClient, __dirname);
    }

    // ****************************************************************************
    // Outputs
    // ****************************************************************************

    // Init output folder
    mkdirSync(outputFolderPath, { recursive: true });

    // Output GraphQL schema no directives
    if (inputGraphQLSchema != '') {
    
        outputSchema = schemaStringify(schemaModel, false);
        if ( outputSchemaFile == '' ) {
            if (createUpdatePipelineName == '') { 
                outputSchemaFile = outputFolderPath + '/output.schema.graphql';
            } else {
                outputSchemaFile = `${outputFolderPath}/${createUpdatePipelineName}.schema.graphql`;
            } 
        }

        try {
            writeFileSync(outputSchemaFile, outputSchema);
            if (!quiet) console.log('Wrote GraphQL schema to file: ' + yellow(outputSchemaFile));
        } catch (err) {
            console.error('Error writing GraphQL schema to file: ' + outputSchemaFile);
        }


        // Output GraphQL schema with directives
        outputSourceSchema = schemaStringify(schemaModel, true);
        if ( outputSourceSchemaFile == '' ) {
            if (createUpdatePipelineName == '') { 
                outputSourceSchemaFile = outputFolderPath + '/output.source.schema.graphql';
            } else {
                outputSourceSchemaFile = `${outputFolderPath}/${createUpdatePipelineName}.source.schema.graphql`;
            } 
        }   

        try {
            writeFileSync(outputSourceSchemaFile, outputSourceSchema);
            if (!quiet) console.log('Wrote GraphQL schema to file: ' + yellow(outputSourceSchemaFile));
        } catch (err) {
            console.error('Error writing GraphQL schema to file: ' + outputSourceSchemaFile);
        }


        // Output Neptune schema
        if (outputNeptuneSchemaFile == '') {
            if (createUpdatePipelineName == '') { 
                outputNeptuneSchemaFile = outputFolderPath + '/output.neptune.schema.json';
            } else {
                outputNeptuneSchemaFile = `${outputFolderPath}/${createUpdatePipelineName}.neptune.schema.json`;
            } 
        }

        try {
            writeFileSync(outputNeptuneSchemaFile, inputGraphDBSchema);
            if (!quiet) console.log('Wrote Neptune schema to file: ' + yellow(outputNeptuneSchemaFile));
        } catch (err) {
            console.error('Error writing Neptune schema to file: ' + outputNeptuneSchemaFile);
        }


        // Output Lambda resolver
        if (outputLambdaResolverFile == '') { 
            outputLambdaResolverFile = outputFolderPath + '/output.resolver.graphql.js'; 
        }

        try {
            writeFileSync(outputLambdaResolverFile, outputLambdaResolver);
            if (!quiet) console.log('Wrote Lambda resolver to file: ' + yellow(outputLambdaResolverFile));
        } catch (err) {
            console.error('Error writing Lambda resolver to file: ' + outputLambdaResolverFile);
        }


        // Output Javascript resolver
        if (outputJSResolverFile == '') {
            if (createUpdatePipelineName == '') { 
                outputJSResolverFile = outputFolderPath + '/output.resolver.graphql.js';
            } else {
                outputJSResolverFile = `${outputFolderPath}/${createUpdatePipelineName}.resolver.graphql.js`;
            } 
        }

        try {
            writeFileSync(outputJSResolverFile, outputJSResolver);
            if (!quiet) console.log('Wrote Javascript resolver to file: ' + yellow(outputJSResolverFile));
        } catch (err) {
            console.error('Error writing Javascript resolver to file: ' + outputJSResolverFile);
        }


        // Output Lambda Zip file
        switch (queryClient) {
            case 'http':
                outputLambdaPackagePath = '/../templates/Lambda4AppSyncHTTP';
            break;
            case 'sdk':
                if (neptuneType === NEPTUNE_DB) {
                    outputLambdaPackagePath = '/../templates/Lambda4AppSyncSDK';
                } else {
                    outputLambdaPackagePath = '/../templates/Lambda4AppSyncGraphSDK';
                }
            break;
        }

        if  ( !(createUpdatePipeline || inputCDKpipeline) && createLambdaZip) {

            if (outputLambdaResolverZipFile == '' && outputLambdaResolverZipName == '')  
                outputLambdaResolverZipFile = outputFolderPath + '/output.lambda.zip';
            
            if (outputLambdaResolverZipFile == '' && outputLambdaResolverZipName != '')  
                outputLambdaResolverZipFile = outputFolderPath + '/' + outputLambdaResolverZipName + '.zip';

            try {
                if (!quiet) spinner = ora('Creating Lambda ZIP ...').start();
                await createLambdaDeploymentPackage(__dirname + outputLambdaPackagePath, outputLambdaResolverZipFile);                                
                if (!quiet) {
                    spinner.stop();
                    console.log('Wrote Lambda ZIP file: ' + yellow(outputLambdaResolverZipFile));
                }
            } catch (err) {
                console.error('Error creating Lambda ZIP file: ' + err);
            }
           
        }


        // Create Update AWS Pipeline
        if (createUpdatePipeline) {
            try {
                let endpointParts = createUpdatePipelineEndpoint.split(':');
                if (endpointParts.length < 2) {
                    console.error('Neptune endpoint must be in the form of host:port');
                    process.exit(1);
                }
                let neptuneHost = endpointParts[0];
                let neptunePort = endpointParts[1];

                if (!quiet) console.log('\nCreating AWS pipeline resources')
                await createUpdateAWSpipeline(  createUpdatePipelineName, 
                                                createUpdatePipelineNeptuneDatabaseName, 
                                                createUpdatePipelineRegion,
                                                outputSchema,
                                                schemaModel,
                                                __dirname + outputLambdaPackagePath,
                                                outputSchemaMutations,
                                                quiet,
                                                __dirname,
                                                isNeptuneIAMAuth,
                                                neptuneHost,
                                                neptunePort,
                                                outputFolderPath,
                                                neptuneType );            
            } catch (err) {
                console.error('Error creating AWS pipeline: ' + err);
            }
        }

        // Output CDK
        if (inputCDKpipeline) {
            try {
                if (!quiet) console.log('\nCreating CDK File')

                let endpointParts = inputCDKpipelineEnpoint.split(':');
                if (endpointParts.length < 2) {
                    console.error('Neptune endpoint must be in the form of host:port');
                    process.exit(1);
                }
                let neptuneHost = endpointParts[0];
                let neptunePort = endpointParts[1];

                
                if (inputCDKpipelineFile == '') {                
                    inputCDKpipelineFile = `${outputFolderPath}/${inputCDKpipelineName}-cdk.js`;
                }

                await createAWSpipelineCDK({
                    pipelineName: inputCDKpipelineName,
                    neptuneDBName: inputCDKpipelineDatabaseName,
                    neptuneDBregion: inputCDKpipelineRegion,
                    appSyncSchema: outputSchema,
                    schemaModel: schemaModel,
                    lambdaFilesPath: __dirname + outputLambdaPackagePath,
                    outputFile: inputCDKpipelineFile,
                    __dirname: __dirname,
                    quiet: quiet,
                    isNeptuneIAMAuth: isNeptuneIAMAuth,
                    neptuneHost: neptuneHost,
                    neptunePort: neptunePort,
                    outputFolderPath: outputFolderPath,
                    neptuneType: neptuneType
                });
            } catch (err) {
                console.error('Error creating CDK File: ' + err);
            }
        }

        if (!quiet) console.log('\nDone\n');
    }

    // Remove AWS Pipeline
    if ( removePipelineName != '') {
        if (!quiet) console.log('\nRemoving pipeline AWS resources, name: ' + yellow(removePipelineName))
        let resourcesToRemove = null;
        let resourcesFile = `${outputFolderPath}/${removePipelineName}-resources.json`;
        if (!quiet) console.log('Using file: ' + yellow(resourcesFile));
        try {
            resourcesToRemove = readFileSync(resourcesFile, 'utf8');
        } catch (err) {
            console.error('Error reading AWS pipeline resources file: ' + resourcesFile + ' ' + err);
            process.exit(1);
        }
        await removeAWSpipelineResources(JSON.parse(resourcesToRemove), quiet);
    }
        
}


export { main };