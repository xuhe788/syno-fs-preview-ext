const KEY = 'sites'; // { host: string, port?: string, enabled: boolean }[]

function parseHostPort(input){
  let s = (input || '').trim();
  if(!s) return null;
  s = s.replace(/^https?:\/\//i,'').replace(/\/.*$/,'');
  const idx = s.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(s.slice(idx+1))) {
    return { host: s.slice(0, idx), port: s.slice(idx+1) };
  }
  // 不带端口
  return { host: s, port: undefined };
}

async function loadSites(){
  const obj = await chrome.storage.local.get(KEY);
  const sites = obj[KEY];
  return Array.isArray(sites) ? sites : [];
}

async function saveSites(sites){
  await chrome.storage.local.set({ [KEY]: sites });
}

function render(sites){
  const tbody = document.getElementById('list');
  tbody.innerHTML = '';
  if(!sites.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');
    td.colSpan=3; td.innerHTML='<span class="muted">（空）可填 host 或 host:port，例如 nxuhe.com:7071 或 nxuhe.com</span>';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  for(const item of sites){
    const tr=document.createElement('tr');
    const td1=document.createElement('td'); td1.textContent=item.port ? `${item.host}:${item.port}` : item.host;
    const td2=document.createElement('td');
    const chk=document.createElement('input'); chk.type='checkbox'; chk.checked=!!item.enabled;
    chk.addEventListener('change', async ()=>{
      item.enabled = chk.checked; await saveSites(sites);
    });
    td2.appendChild(chk);
    const td3=document.createElement('td');
    const del=document.createElement('button'); del.textContent='删除';
    del.addEventListener('click', async ()=>{
      const idx = sites.findIndex(x => x.host===item.host && x.port===item.port);
      if(idx>=0){ sites.splice(idx,1); await saveSites(sites); render(sites); }
    });
    td3.appendChild(del);

    tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    tbody.appendChild(tr);
  }
}

async function init(){
  const sites = await loadSites();
  render(sites);

  document.getElementById('add').addEventListener('click', async ()=>{
    const raw = document.getElementById('hostport').value;
    const parsed = parseHostPort(raw);
    const enabled = document.getElementById('enabled').checked;
    if(!parsed){ alert('请填写 host 或 host:port'); return; }
    const list = await loadSites();
    const i = list.findIndex(x => x.host===parsed.host && x.port===parsed.port);
    if(i>=0){ list[i].enabled = enabled; } else { list.push({ ...parsed, enabled }); }
    await saveSites(list);
    render(list);
  });

  document.getElementById('add-current').addEventListener('click', async ()=>{
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if(!tab || !tab.url){ alert('未获取到当前标签页 URL'); return; }
    try{
      const u = new URL(tab.url);
      const host = u.hostname;
      const port = u.port || undefined;
      const list = await loadSites();
      const i = list.findIndex(x => x.host===host && x.port===port);
      if(i>=0){ list[i].enabled = true; } else { list.push({host, port, enabled:true}); }
      await saveSites(list);
      render(list);
      document.getElementById('hostport').value = port ? `${host}:${port}` : host;
      document.getElementById('enabled').checked = true;
    }catch(_){
      alert('解析当前页面 URL 失败');
    }
  });
}
init();
