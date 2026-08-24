'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sysserver = require('../app/sysserver');

function pageRequest(port, path, options = {}) {
  return fetch('http://127.0.0.1:' + port + path, Object.assign({}, options, { headers: Object.assign({ 'Sec-Fetch-Site':'same-origin' }, options.headers || {}) }));
}

test('integrated GitHub API is same-origin and rotating-capability gated', async t => {
  const githubApp = {
    publicSettings: () => ({ ok:true, configured:true, connected:false, clientId:'Iv1.public', repository:'acme/repo', branch:'main' }),
    repositories: async () => ({ok:true,items:[{fullName:'acme/repo'}]}), overview: async () => ({ok:true}), pulls:async()=>({ok:true,items:[]}), pullDetails:async()=>({ok:true}), actions:async()=>({ok:true}), runDetails:async()=>({ok:true}), workflowDispatchInfo:async()=>({ok:true,hasDispatch:true,inputs:[]}), action:async()=>({ok:true}), open:async()=>({ok:true}),
  };
  const port = await sysserver.start({ githubApp, githubCapabilityTtlMs:10000 });
  t.after(() => sysserver.stop());
  sysserver.setActivePage('github');
  const first = sysserver.issueGitHubCapability();

  const cross = await fetch('http://127.0.0.1:' + port + '/api/github/settings', { headers:{'Sec-Fetch-Site':'cross-site',Authorization:'Bearer '+first} });
  assert.equal(cross.status,403);
  const settingsResponse = await pageRequest(port,'/api/github/settings',{headers:{Authorization:'Bearer '+first}});
  assert.equal(settingsResponse.status,200);
  const settings = await settingsResponse.json();
  assert.equal(settings.clientId,'Iv1.public');
  assert.equal(Object.hasOwn(settings,'accessToken'),false);
  const second = settingsResponse.headers.get('x-open-quake-capability');
  assert.match(second,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await pageRequest(port,'/api/github/settings',{headers:{Authorization:'Bearer '+first}})).status,403);

  const repositoriesResponse = await pageRequest(port,'/api/github/repositories',{headers:{Authorization:'Bearer '+second}});
  assert.deepEqual((await repositoriesResponse.json()).items,[{fullName:'acme/repo'}]);
  const third = repositoriesResponse.headers.get('x-open-quake-capability');
  const rejected = await pageRequest(port,'/api/github/settings',{method:'POST',headers:{Authorization:'Bearer '+third,'Content-Type':'application/json'},body:JSON.stringify({clientId:'Iv1.next',repository:'acme/repo',branch:'main'})});
  assert.equal((await rejected.json()).code,'invalid_operation');

  const page = await pageRequest(port,'/github'); assert.equal(page.status,200); assert.match(page.headers.get('content-type'),/text\/html/);
  const script = await pageRequest(port,'/github.js'); assert.equal(script.status,200); assert.match(script.headers.get('content-type'),/javascript/);
  const stateScript = await pageRequest(port,'/githubPanelState.js'); assert.equal(stateScript.status,200); assert.match(stateScript.headers.get('content-type'),/javascript/);
});

test('leaving the integrated GitHub page invalidates its capability', async t => {
  const port = await sysserver.start({ githubApp:{publicSettings:()=>({ok:true})} });
  t.after(() => sysserver.stop());
  sysserver.setActivePage('github'); const capability=sysserver.issueGitHubCapability(); sysserver.setActivePage(null);
  const response=await pageRequest(port,'/api/github/settings',{headers:{Authorization:'Bearer '+capability}});
  assert.equal(response.status,403);
});
