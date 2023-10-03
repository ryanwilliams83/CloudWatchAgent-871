#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CloudWatchAgentStack } from '../lib/cloud_watch_agent-stack';

const app = new cdk.App();
new CloudWatchAgentStack(app, 'CloudWatchAgentStack');
