const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');
const { concat } = require('lodash');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  let preScript;
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    core.info(`Preinstalled runner from HomeDir ${config.input.runnerHomeDir}`);
    preScript = [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh'
    ];
  } else {
    core.info(`The runner will be downloaded.`);
    preScript = [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.299.1/actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz'
    ];
  }
  const url = new URL(config.githubUrl);
  //'rm -f .runner',
  //'./config.sh remove',
  const configScript = [
    'export RUNNER_ALLOW_RUNASROOT=1',
    `./config.sh --unattended \\`,
    `  --url ${url.protocol}//${url.host}/${config.githubContext.owner}/${config.githubContext.repo} \\`,
    `  --token ${githubRegistrationToken} \\`,
    `  --name ditto-system-tests-runner-${label} \\`,
    `  --labels ${label},ditto-system-tests`,
    './run.sh'
  ];
  return concat(preScript, configScript);
}

async function getSubnetId(ec2) {
  const filters = {
    Filters: [
      { Name: 'default-for-az', Values: ['true'] },
      { Name: 'state', Values: ['available'] },
    ]
  };
  let result;
  await ec2.describeSubnets(filters, function(err, data) {
    if (err) {    // an error occurred
      core.info('Response err: ' + err);
      core.info(err.stack);
    } else {
      // core.info(`Data Response ${data.Subnets.length}: ${JSON.stringify(data)}`);
      if (data.Subnets.length > 0) {
        result = data.Subnets[0];
      } else {
        core.info(`Error: Default subnet not found or not available`);   // default zone missing or not available
      }
    }
  }).promise();
  return result;
}

async function getSecurityGroupId(ec2, subnet) {
  //core.info(`Search for security groups in VpcId: ${subnet.VpcId}`);
  const searchTag = 'ssh_http'
  const filters = [
    { Name: 'vpc-id', Values: [subnet.VpcId] },
    { Name: 'tag:Name', Values: [searchTag] }
  ];
  let result = '';
  await ec2.describeSecurityGroups({Filters: filters}, function(err, data) {
    if (err) {
      core.info('Response err: ' + err);           // error
      core.info(err.stack); // an error occurred
    } else {
      // core.info(`Data Response: ${JSON.stringify(data)}`);
      if (data.SecurityGroups.length > 0) {
        result = data.SecurityGroups[0].GroupId;
      } else {
        core.info(`Error: Subnet with Name=${searchTag} not found in default VpcId ${subnet.VpcId}`);   // default zone missing or not available
      }
    }
  }).promise();
  return result;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: '',
    SecurityGroupIds: [],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications
  };

  try {
    const subnet = await getSubnetId(ec2);
    params.SubnetId = subnet.SubnetId;
    core.info(`Subnet ${params.SubnetId}`);
    params.SecurityGroupIds = [await getSecurityGroupId(ec2, subnet)];
    core.info(`Security Group ${params.SecurityGroupIds}`);
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
