// Deploys salesforce/force-app to the org (Metadata API), sets the voice server key on the credential,
// and grants the call permission set to the site guest user and the running admin.
// Usage: node scripts/deploy-salesforce.js [--check-only]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { getAccessToken, sfRequest } = require('../src/salesforce');
const { buildZip } = require('./zip');

const API = 'v62.0';
const SOURCE = path.join(__dirname, '..', 'salesforce', 'force-app', 'main', 'default');
const TEST_CLASSES = ['TiffanyVoiceCallControllerTest'];
const PERMISSION_SET = 'Tiffany_Voice_Call_Access';
const SITE_PROFILE = 'TiffanyDesigns Profile';
const FOLDERS = {
  classes: { type: 'ApexClass', member: (f) => f.endsWith('.cls') && path.basename(f, '.cls') },
  lwc: { type: 'LightningComponentBundle', member: (f) => f.split('/')[1] },
  externalCredentials: { type: 'ExternalCredential', member: (f) => path.basename(f).split('.')[0] },
  namedCredentials: { type: 'NamedCredential', member: (f) => path.basename(f).split('.')[0] },
  permissionsets: { type: 'PermissionSet', member: (f) => path.basename(f).split('.')[0] },
};

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function packageXml(files) {
  const types = {};
  for (const file of files) {
    const folder = FOLDERS[file.split('/')[0]];
    const member = folder && folder.member(file);
    if (member) (types[folder.type] ||= new Set()).add(member);
  }
  const body = Object.entries(types)
    .map(([type, names]) => `    <types>\n${[...names].sort().map((n) => `        <members>${n}</members>`).join('\n')}\n        <name>${type}</name>\n    </types>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n    <version>${API.slice(1)}</version>\n</Package>\n`;
}

function buildPackage(publicBaseUrl) {
  const files = listFiles(SOURCE);
  const entries = files.map((file) => {
    let data = fs.readFileSync(path.join(SOURCE, file));
    if (file.startsWith('namedCredentials/')) {
      data = Buffer.from(data.toString('utf8').replace('{{PUBLIC_BASE_URL}}', publicBaseUrl));
    }
    return { name: file, data };
  });
  entries.push({ name: 'package.xml', data: Buffer.from(packageXml(files)) });
  return buildZip(entries);
}

// The deploy endpoint wants exactly these two parts, the options part without a file name.
function multipartBody(boundary, options, zip) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(options)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deploy.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function startDeploy(zip, checkOnly) {
  const { accessToken, instanceUrl } = await getAccessToken();
  const deployOptions = { checkOnly, rollbackOnError: true, singlePackage: true, testLevel: 'RunSpecifiedTests', runTests: TEST_CLASSES };
  const boundary = `----tiffany${Date.now().toString(16)}`;
  const res = await fetch(`${instanceUrl}/services/data/${API}/metadata/deployRequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, { deployOptions }, zip),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Deploy request failed (${res.status}): ${JSON.stringify(data)}`);
  return data.id;
}

async function waitForDeploy(id) {
  for (;;) {
    const { deployResult } = await sfRequest(`/metadata/deployRequest/${id}?includeDetails=true`);
    if (deployResult.done) return deployResult;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function report(result) {
  console.log(`\nDeploy ${result.status} (${result.numberComponentsDeployed}/${result.numberComponentsTotal} components, ${result.numberTestsCompleted}/${result.numberTestsTotal} tests)`);
  const failures = [].concat(result.details?.componentFailures || []);
  for (const f of failures) console.log(`  FAILED ${f.componentType} ${f.fullName}: ${f.problem}${f.lineNumber ? ` (line ${f.lineNumber})` : ''}`);
  const tests = result.details?.runTestResult;
  for (const f of [].concat(tests?.failures || [])) console.log(`  TEST FAILED ${f.name}.${f.methodName}: ${f.message}`);
  for (const c of [].concat(tests?.codeCoverage || [])) {
    const total = Number(c.numLocations) || 0;
    const missed = Number(c.numLocationsNotCovered) || 0;
    if (total) console.log(`  Coverage ${c.name}: ${Math.round(((total - missed) / total) * 100)}%`);
  }
}

// The credential value is a secret, so it is set through the Connect API rather than shipped in metadata.
async function setCredential(apiKey) {
  const body = JSON.stringify({
    externalCredential: 'Tiffany_Voice_API',
    principalName: 'main',
    principalType: 'NamedPrincipal',
    credentials: { apiKey: { value: apiKey, encrypted: true } },
  });
  try {
    await sfRequest('/named-credentials/credential', { method: 'POST', body });
  } catch (err) {
    await sfRequest('/named-credentials/credential', { method: 'PUT', body });
  }
}

async function grantAccess() {
  const ps = await sfRequest(`/query?q=${encodeURIComponent(`SELECT Id FROM PermissionSet WHERE Name = '${PERMISSION_SET}'`)}`);
  const permissionSetId = ps.records[0].Id;
  const me = await sfRequest('/chatter/users/me');
  const guests = await sfRequest(`/query?q=${encodeURIComponent(`SELECT Id, Name FROM User WHERE UserType = 'Guest' AND Profile.Name = '${SITE_PROFILE}'`)}`);
  const users = [{ Id: me.id, Name: me.name }, ...guests.records];
  for (const user of users) {
    try {
      await sfRequest('/sobjects/PermissionSetAssignment', { method: 'POST', body: JSON.stringify({ AssigneeId: user.Id, PermissionSetId: permissionSetId }) });
      console.log(`  Granted ${PERMISSION_SET} to ${user.Name}`);
    } catch (err) {
      if (!/DUPLICATE_VALUE/.test(err.message)) throw err;
      console.log(`  ${user.Name} already has ${PERMISSION_SET}`);
    }
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const siteKey = process.env.SITE_CALL_API_KEY;
  if (!/^https:\/\//.test(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL must be the server\'s https address');
  if (!siteKey) throw new Error('SITE_CALL_API_KEY is not set');

  console.log(`${checkOnly ? 'Validating' : 'Deploying'} salesforce/force-app with the voice server at ${publicBaseUrl}`);
  const id = await startDeploy(buildPackage(publicBaseUrl), checkOnly);
  const result = await waitForDeploy(id);
  report(result);
  if (!result.success) process.exit(1);
  if (checkOnly) return;

  await setCredential(siteKey);
  console.log('  Voice server key stored on the Tiffany_Voice_API credential');
  await grantAccess();
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
