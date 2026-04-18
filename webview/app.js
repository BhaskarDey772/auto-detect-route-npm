// @ts-nocheck
// Browser-side SPA for Auto Detect Route npm middleware
// No framework, no build step — plain vanilla JS

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  // BASE is injected by the middleware as window.__ADR_BASE__ (e.g. '/api-tester')
  const BASE = (window.__ADR_BASE__ || '').replace(/\/$/, '');

  // ── State ───────────────────────────────────────────────────────────────────
  let allRoutes     = [];
  let currentRoute  = null;
  let currentBaseUrl = '{{BASE_URL}}';  // always use variable — resolved at send time
  let groupBy       = localStorage.getItem('adr_groupBy') || 'file';
  let filterText    = '';
  let queryParams   = [];   // [{key, value, enabled}]
  let customHeaders = [];   // [{key, value, enabled}]
  let variables     = loadVariablesFromStorage();
  let manualUrl     = null;
  let saveTimer     = null;
  let scanning      = false;

  // ── localStorage helpers ────────────────────────────────────────────────────
  function loadVariablesFromStorage() {
    try { return JSON.parse(localStorage.getItem('adr_variables') || '[]'); } catch { return []; }
  }

  /**
   * Ensure BASE_URL variable exists in the variables list.
   * Called on startup and after rescan with the server's configured baseUrl.
   * Only seeds if not already present — never overwrites a user-edited value.
   */
  function seedBaseUrlVariable(serverBaseUrl) {
    const exists = variables.some(v => v.name === 'BASE_URL');
    if (!exists) {
      variables.unshift({ name: 'BASE_URL', value: serverBaseUrl || 'http://localhost:3000', enabled: true });
      persistVariables();
    }
  }

  function persistVariables() {
    localStorage.setItem('adr_variables', JSON.stringify(variables));
  }

  function loadRouteState(id) {
    try { return JSON.parse(localStorage.getItem('adr_rs_' + id) || 'null'); } catch { return null; }
  }

  function persistRouteState(id, state) {
    localStorage.setItem('adr_rs_' + id, JSON.stringify(state));
    // Trim old entries to prevent unbounded growth (keep latest 200)
    const keys = Object.keys(localStorage).filter(k => k.startsWith('adr_rs_'));
    if (keys.length > 200) {
      keys.slice(0, keys.length - 200).forEach(k => localStorage.removeItem(k));
    }
  }

  // ── API helpers ─────────────────────────────────────────────────────────────
  async function apiFetchRoutes() {
    const r = await fetch(BASE + '/api/routes');
    if (!r.ok) throw new Error('Failed to fetch routes: ' + r.status);
    return r.json();
  }

  async function apiRescan() {
    const r = await fetch(BASE + '/api/rescan');
    if (!r.ok) throw new Error('Rescan failed: ' + r.status);
    return r.json();
  }

  async function apiProxy(state) {
    // Attach enabled variables for server-side {{VAR}} substitution
    const vars = {};
    variables.filter(v => v.enabled).forEach(v => { vars[v.name] = v.value; });

    const r = await fetch(BASE + '/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state, _variables: vars }),
    });
    return r.json();
  }

  // ── Variable substitution (client-side, for URL preview only) ────────────────
  function substituteVars(text) {
    if (!text || !text.includes('{{')) return text;
    const map = new Map(variables.filter(v => v.enabled).map(v => [v.name, v.value]));
    return text.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, name) =>
      map.has(name) ? map.get(name) : _m
    );
  }

  function unresolvedVars(text) {
    if (!text || !text.includes('{{')) return [];
    const map = new Map(variables.filter(v => v.enabled).map(v => [v.name, v.value]));
    const found = [];
    const re = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!map.has(m[1])) found.push(m[1]);
    }
    return found;
  }

  // ── URL building ─────────────────────────────────────────────────────────────
  function buildUrl(resolve) {
    if (!currentRoute) return '';
    let p = currentRoute.path;
    if (currentRoute.params) {
      for (const param of currentRoute.params) {
        if (param.type === 'path' || param.type === 'template') {
          const input = document.getElementById(paramInputId(param));
          let val = input ? input.value.trim() : '';
          if (resolve) val = substituteVars(val);
          const placeholder = paramPlaceholder(param);
          p = p.replace(placeholder, val || placeholder);
        }
      }
    }
    const base = resolve
      ? substituteVars(currentBaseUrl).replace(/\/$/, '')
      : currentBaseUrl.replace(/\/$/, '');
    const url = base + p;
    const qp = queryParams.filter(q => q.enabled && q.key.trim());
    if (qp.length > 0) {
      const qs = qp.map(q => {
        const k = resolve ? substituteVars(q.key) : q.key;
        const v = resolve ? substituteVars(q.value) : q.value;
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      }).join('&');
      return url + '?' + qs;
    }
    return url;
  }

  function refreshUrlPreview() {
    const urlPreview = document.getElementById('url-preview');
    if (!urlPreview) return;

    if (manualUrl !== null) {
      urlPreview.value = manualUrl;
      urlPreview.title = '';
    } else {
      const raw      = buildUrl(false);  // {{BASE_URL}}/users/:id  — shown in bar
      const resolved = buildUrl(true);   // http://localhost:3000/users/123 — tooltip
      urlPreview.value = raw;
      urlPreview.title = resolved !== raw ? 'Resolves to: ' + resolved : '';
    }

    // Unresolved variable warning
    const varWarning = document.getElementById('var-warning');
    if (varWarning) {
      const bearerVal = document.getElementById('bearer-token')?.value || '';
      const allText = [
        manualUrl !== null ? manualUrl : buildUrl(false),
        bearerVal,
        ...queryParams.map(q => q.key + q.value),
        ...customHeaders.map(h => h.value),
        document.getElementById('body-editor')?.value || '',
      ].join(' ');
      const unresolved = unresolvedVars(allText);
      if (unresolved.length > 0) {
        varWarning.textContent = '⚠ Unresolved: ' + unresolved.map(n => '{{' + n + '}}').join(', ');
        varWarning.classList.remove('hidden');
      } else {
        varWarning.classList.add('hidden');
      }
    }
  }

  // ── Param helpers ────────────────────────────────────────────────────────────
  function paramInputId(param) {
    return 'pathparam-' + param.name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  function paramLabel(param) {
    return param.type === 'template' ? '${' + param.name + '}' : ':' + param.name;
  }
  function paramPlaceholder(param) {
    return param.type === 'template' ? '${' + param.name + '}' : ':' + param.name;
  }

  // ── State persistence ────────────────────────────────────────────────────────
  function collectPersistedState() {
    const pathParamValues = {};
    if (currentRoute && currentRoute.params) {
      for (const param of currentRoute.params) {
        if (param.type === 'path' || param.type === 'template') {
          const input = document.getElementById(paramInputId(param));
          if (input) pathParamValues[param.name] = input.value;
        }
      }
    }
    return {
      queryParams: queryParams.slice(),
      headers: customHeaders.slice(),
      body: document.getElementById('body-editor')?.value || '',
      bodyEnabled: document.getElementById('body-enabled')?.checked || false,
      pathParamValues,
      manualUrl: manualUrl !== null ? manualUrl : undefined,
      bearerToken: document.getElementById('bearer-token')?.value || undefined,
    };
  }

  function saveCurrentState() {
    if (!currentRoute) return;
    persistRouteState(currentRoute.id, collectPersistedState());
  }

  function scheduleSave() {
    if (!currentRoute) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentState, 400);
  }

  function flashSaved() {
    const el = document.getElementById('save-flash');
    if (!el) return;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 1500);
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  function renderSidebar() {
    const list = document.getElementById('route-list');
    if (!list) return;

    const routes = filterText
      ? allRoutes.filter(r =>
          r.path.toLowerCase().includes(filterText) ||
          r.method.toLowerCase().includes(filterText)
        )
      : allRoutes;

    if (scanning && routes.length === 0) {
      list.innerHTML =
        '<div class="sidebar-state"><div class="spinner"></div><span>Scanning routes&hellip;</span></div>';
      return;
    }

    if (routes.length === 0) {
      list.innerHTML =
        '<div class="sidebar-empty">' +
        (allRoutes.length === 0
          ? 'No routes detected.<br><small>Make sure your Express app entry file is in the scanned directory.</small>'
          : 'No routes match your filter.') +
        '</div>';
      return;
    }

    // Group routes
    const groups = new Map();
    for (const route of routes) {
      const key = groupBy === 'method'
        ? route.method
        : (route.sourceFile.split('/').pop() || route.sourceFile);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(route);
    }

    list.innerHTML = '';
    for (const [key, groupRoutes] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'route-group';

      const header = document.createElement('div');
      header.className = 'route-group-header';
      const label = document.createElement('span');
      label.className = 'route-group-header-label';
      label.textContent = key;
      header.appendChild(label);
      header.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
      groupEl.appendChild(header);

      const items = document.createElement('div');
      items.className = 'route-group-items';

      for (const route of groupRoutes) {
        const item = document.createElement('div');
        item.className = 'route-item' +
          (currentRoute && currentRoute.id === route.id ? ' active' : '');
        item.dataset.routeId = route.id;
        item.innerHTML =
          '<span class="route-method method-' + route.method + '">' + route.method + '</span>' +
          '<span class="route-path">' + escHtml(route.path) + '</span>';
        item.addEventListener('click', () => selectRoute(route));
        items.appendChild(item);
      }

      groupEl.appendChild(items);
      list.appendChild(groupEl);
    }
  }

  function updateSidebarActiveItem() {
    document.querySelectorAll('.route-item').forEach(el => {
      el.classList.toggle('active', el.dataset.routeId === (currentRoute && currentRoute.id));
    });
  }

  // ── Route selection ──────────────────────────────────────────────────────────
  function selectRoute(route) {
    if (currentRoute) saveCurrentState();

    currentRoute = route;
    updateSidebarActiveItem();

    const saved = loadRouteState(route.id);
    let prefilledBody = null;

    // Only skip prefill when there is actual body content already saved.
    // bodyEnabled=true with empty body still gets the prefill applied.
    const savedHasContent = saved && saved.body && saved.body.trim();

    if (!savedHasContent && ['POST', 'PUT', 'PATCH'].includes(route.method)) {
      // Build a skeleton JSON object from detected req.body fields.
      // Fields named 'file' / ending in 'File' / 'image' etc. are skipped
      // (file upload support is not yet implemented).
      const bodyOnlyFields = (route.bodyFields || []).filter(f =>
        !['file', 'files', 'image', 'photo', 'avatar', 'attachment'].includes(f.toLowerCase()) &&
        !f.toLowerCase().endsWith('file') &&
        !f.toLowerCase().endsWith('image')
      );
      if (bodyOnlyFields.length > 0) {
        const obj = {};
        bodyOnlyFields.forEach(f => { obj[f] = ''; });
        prefilledBody = JSON.stringify(obj, null, 2);
      } else {
        // Always provide an empty JSON body for POST/PUT/PATCH even when
        // body fields could not be statically detected (e.g. named handlers).
        prefilledBody = '{\n  \n}';
      }
    }

    loadRoutePanel(route, saved, prefilledBody);
  }

  // ── Route panel ──────────────────────────────────────────────────────────────
  function loadRoutePanel(route, saved, prefilledBody) {
    manualUrl = null;

    if (saved) {
      queryParams   = saved.queryParams || [];
      customHeaders = saved.headers || [];
      const bodyEditor   = document.getElementById('body-editor');
      const bodyEnabled  = document.getElementById('body-enabled');
      const bt = document.getElementById('bearer-token');
      if (bt) bt.value = saved.bearerToken || '';
      if (saved.manualUrl) manualUrl = saved.manualUrl;
      // Apply prefill whenever body has no actual content
      if (prefilledBody && !(saved.body && saved.body.trim())) {
        if (bodyEditor)  bodyEditor.value   = prefilledBody;
        if (bodyEnabled) bodyEnabled.checked = true;
        if (bodyEditor)  bodyEditor.disabled = false;
      } else {
        if (bodyEditor)  bodyEditor.value   = saved.body || '';
        if (bodyEnabled) bodyEnabled.checked = !!saved.bodyEnabled;
        if (bodyEditor)  bodyEditor.disabled = !(saved.bodyEnabled);
      }
    } else {
      queryParams   = [];
      customHeaders = [];
      const bodyEditor  = document.getElementById('body-editor');
      const bodyEnabled = document.getElementById('body-enabled');
      const bt = document.getElementById('bearer-token');
      if (bt) bt.value = '';
      if (prefilledBody) {
        if (bodyEditor)  bodyEditor.value   = prefilledBody;
        if (bodyEnabled) bodyEnabled.checked = true;
        if (bodyEditor)  bodyEditor.disabled = false;
      } else {
        if (bodyEditor)  { bodyEditor.value = ''; bodyEditor.disabled = true; }
        if (bodyEnabled) bodyEnabled.checked = false;
      }
    }

    document.getElementById('body-error')?.classList.add('hidden');

    // Method badge
    const badge = document.getElementById('method-badge');
    if (badge) {
      badge.textContent = route.method;
      badge.className = 'method-badge method-' + route.method;
    }

    // Source link
    const sourceLink = document.getElementById('source-link');
    const sourceText = document.getElementById('source-text');
    if (sourceLink && sourceText) {
      const fileName = route.sourceFile.split('/').pop();
      sourceText.textContent = fileName + ':' + route.sourceLine;
      sourceLink.classList.remove('hidden');
    }

    // Enable send button
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = false;

    // Render path params, then restore saved values
    renderPathParams();
    if (saved && saved.pathParamValues) {
      for (const param of (route.params || [])) {
        if (param.type === 'path' || param.type === 'template') {
          const input = document.getElementById(paramInputId(param));
          if (input && saved.pathParamValues[param.name] !== undefined) {
            input.value = saved.pathParamValues[param.name];
          }
        }
      }
    }

    renderQueryParams();
    renderHeaders();
    refreshUrlPreview();
    clearResponse();

    // Hide routes-updated banner when a route is loaded
    document.getElementById('routes-updated-banner')?.classList.add('hidden');
  }

  // ── Path params ──────────────────────────────────────────────────────────────
  function renderPathParams() {
    const section = document.getElementById('path-params-section');
    const list    = document.getElementById('path-params-list');
    if (!section || !list) return;

    const pathParams = (currentRoute?.params || []).filter(
      p => p.type === 'path' || p.type === 'template'
    );

    if (pathParams.length === 0) {
      section.classList.add('hidden');
      return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    for (const param of pathParams) {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML =
        '<span class="param-label">' + escHtml(paramLabel(param)) + '</span>' +
        '<input id="' + escHtml(paramInputId(param)) +
        '" class="param-value" type="text" placeholder="value">';
      list.appendChild(row);
      row.querySelector('input').addEventListener('input', () => {
        refreshUrlPreview();
        scheduleSave();
      });
    }
  }

  // ── Query params ─────────────────────────────────────────────────────────────
  function renderQueryParams() {
    const list = document.getElementById('query-params-list');
    if (!list) return;
    list.innerHTML = '';

    if (queryParams.length === 0) {
      list.innerHTML = '<div class="empty-hint">No query parameters yet.</div>';
      return;
    }

    queryParams.forEach((qp, i) => {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML =
        '<input type="checkbox" ' + (qp.enabled ? 'checked' : '') + ' data-qi="' + i + '">' +
        '<input class="param-key" type="text" placeholder="key" value="' + escHtml(qp.key) + '" data-qi="' + i + '">' +
        '<input class="param-value" type="text" placeholder="value" value="' + escHtml(qp.value) + '" data-qi="' + i + '">' +
        '<button class="remove-btn" data-qi="' + i + '" title="Remove">\xd7</button>';
      list.appendChild(row);

      row.querySelector('input[type=checkbox]').addEventListener('change', e => {
        queryParams[+e.target.dataset.qi].enabled = e.target.checked;
        refreshUrlPreview(); scheduleSave();
      });
      row.querySelectorAll('input.param-key, input.param-value').forEach(inp => {
        inp.addEventListener('input', e => {
          const idx = +e.target.dataset.qi;
          if (e.target.classList.contains('param-key')) queryParams[idx].key = e.target.value;
          else queryParams[idx].value = e.target.value;
          refreshUrlPreview(); scheduleSave();
        });
      });
      row.querySelector('.remove-btn').addEventListener('click', e => {
        queryParams.splice(+e.target.dataset.qi, 1);
        renderQueryParams(); refreshUrlPreview(); scheduleSave();
      });
    });
  }

  // ── Custom headers ────────────────────────────────────────────────────────────
  function renderHeaders() {
    const list = document.getElementById('headers-list');
    if (!list) return;
    list.innerHTML = '';

    if (customHeaders.length === 0) {
      list.innerHTML = '<div class="empty-hint">No custom headers yet.</div>';
      return;
    }

    customHeaders.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML =
        '<input type="checkbox" ' + (h.enabled ? 'checked' : '') + ' data-hi="' + i + '">' +
        '<input class="param-key" type="text" placeholder="key" value="' + escHtml(h.key) + '" data-hi="' + i + '">' +
        '<input class="param-value" type="text" placeholder="value" value="' + escHtml(h.value) + '" data-hi="' + i + '">' +
        '<button class="remove-btn" data-hi="' + i + '" title="Remove">\xd7</button>';
      list.appendChild(row);

      row.querySelector('input[type=checkbox]').addEventListener('change', e => {
        customHeaders[+e.target.dataset.hi].enabled = e.target.checked; scheduleSave();
      });
      row.querySelectorAll('input.param-key, input.param-value').forEach(inp => {
        inp.addEventListener('input', e => {
          const idx = +e.target.dataset.hi;
          if (e.target.classList.contains('param-key')) customHeaders[idx].key = e.target.value;
          else customHeaders[idx].value = e.target.value;
          scheduleSave();
        });
      });
      row.querySelector('.remove-btn').addEventListener('click', e => {
        customHeaders.splice(+e.target.dataset.hi, 1);
        renderHeaders(); scheduleSave();
      });
    });
  }

  // ── Send request ──────────────────────────────────────────────────────────────
  async function sendRequest() {
    if (!currentRoute) return;

    const bodyEditor  = document.getElementById('body-editor');
    const bodyEnabled = document.getElementById('body-enabled');
    const bodyError   = document.getElementById('body-error');

    if (bodyEnabled.checked && bodyEditor.value.trim()) {
      try {
        JSON.parse(bodyEditor.value);
        bodyError.classList.add('hidden');
      } catch (e) {
        bodyError.textContent = 'Invalid JSON: ' + e.message;
        bodyError.classList.remove('hidden');
        return;
      }
    }

    const pathParamValues = {};
    for (const param of (currentRoute.params || [])) {
      if (param.type === 'path' || param.type === 'template') {
        const input = document.getElementById(paramInputId(param));
        pathParamValues[param.name] = input ? input.value : '';
      }
    }

    // Inject bearer token into headers if set and not already present
    const effectiveHeaders = customHeaders.slice();
    const bearerVal = document.getElementById('bearer-token')?.value.trim() || '';
    if (bearerVal) {
      const hasAuth = effectiveHeaders.some(
        h => h.enabled && h.key.trim().toLowerCase() === 'authorization'
      );
      if (!hasAuth) {
        effectiveHeaders.unshift({ key: 'Authorization', value: 'Bearer ' + bearerVal, enabled: true });
      }
    }

    const state = {
      route: currentRoute,
      baseUrl: currentBaseUrl,
      pathParamValues,
      queryParams: queryParams.slice(),
      headers: effectiveHeaders,
      body: bodyEditor.value,
      bodyEnabled: bodyEnabled.checked,
    };

    if (manualUrl !== null) {
      state.overrideFullUrl = manualUrl;
    }

    showLoading();

    try {
      const result = await apiProxy(state);
      if (result.error) {
        showError(result.error);
      } else {
        showResponse(result);
      }
    } catch (err) {
      showError(err.message || 'Network error');
    }
  }

  // ── Response display ──────────────────────────────────────────────────────────
  function clearResponse() {
    document.getElementById('resp-loading')?.classList.add('hidden');
    document.getElementById('resp-empty')?.classList.remove('hidden');
    document.getElementById('resp-error')?.classList.add('hidden');
    document.getElementById('response-meta')?.classList.add('hidden');
    document.querySelectorAll('.resp-panel').forEach(p => p.classList.add('hidden'));
  }

  function showLoading() {
    document.getElementById('resp-empty')?.classList.add('hidden');
    document.getElementById('resp-error')?.classList.add('hidden');
    document.querySelectorAll('.resp-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('resp-loading')?.classList.remove('hidden');
  }

  function showResponse(response) {
    document.getElementById('resp-loading')?.classList.add('hidden');
    document.getElementById('resp-empty')?.classList.add('hidden');
    document.getElementById('resp-error')?.classList.add('hidden');

    const statusClass =
      response.status >= 500 ? 'status-5xx' :
      response.status >= 400 ? 'status-4xx' :
      response.status >= 300 ? 'status-3xx' : 'status-2xx';

    const meta = document.getElementById('response-meta');
    if (meta) {
      meta.innerHTML =
        '<span class="status-badge ' + statusClass + '">' +
        response.status + ' ' + escHtml(response.statusText) + '</span>' +
        '<span>' + response.durationMs + 'ms</span>' +
        '<span>' + formatBytes(response.size) + '</span>';
      meta.classList.remove('hidden');
    }

    const pretty = document.getElementById('resp-pretty');
    if (pretty) {
      if (response.bodyParsed !== null && response.bodyParsed !== undefined) {
        pretty.innerHTML = syntaxHighlight(JSON.stringify(response.bodyParsed, null, 2));
      } else {
        pretty.textContent = response.body;
      }
    }

    const raw = document.getElementById('resp-raw');
    if (raw) raw.textContent = response.body;

    const headersList = document.getElementById('resp-headers-list');
    if (headersList) {
      headersList.innerHTML = '';
      for (const [key, val] of Object.entries(response.headers || {})) {
        const row = document.createElement('div');
        row.className = 'resp-header-row';
        row.innerHTML =
          '<span class="resp-header-key">' + escHtml(key) + '</span>' +
          '<span class="resp-header-value">' + escHtml(val) + '</span>';
        headersList.appendChild(row);
      }
    }

    // Switch to Pretty tab
    document.querySelectorAll('.resp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.resp-panel').forEach(p => p.classList.add('hidden'));
    document.querySelector('.resp-tab[data-resp-tab="pretty"]')?.classList.add('active');
    document.getElementById('resp-tab-pretty')?.classList.remove('hidden');
  }

  function showError(message) {
    document.getElementById('resp-loading')?.classList.add('hidden');
    document.getElementById('resp-empty')?.classList.add('hidden');
    const errText = document.getElementById('resp-error-text');
    if (errText) errText.textContent = message;
    document.getElementById('resp-error')?.classList.remove('hidden');
    document.querySelectorAll('.resp-panel').forEach(p => p.classList.add('hidden'));
  }

  // ── Variables modal ────────────────────────────────────────────────────────────
  function openVarsModal() {
    renderVarsTable();
    document.getElementById('vars-modal')?.classList.remove('hidden');
  }

  function closeVarsModal() {
    document.getElementById('vars-modal')?.classList.add('hidden');
    // Refresh URL preview in case vars changed
    refreshUrlPreview();
  }

  function renderVarsTable() {
    const empty = document.getElementById('vars-empty');
    const table = document.getElementById('vars-table');
    const tbody = document.getElementById('vars-tbody');
    if (!empty || !table || !tbody) return;

    if (variables.length === 0) {
      empty.classList.remove('hidden');
      table.classList.add('hidden');
      return;
    }

    empty.classList.add('hidden');
    table.classList.remove('hidden');
    tbody.innerHTML = '';

    variables.forEach((v, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-enabled">' +
          '<input type="checkbox" ' + (v.enabled ? 'checked' : '') + ' data-vi="' + i + '">' +
        '</td>' +
        '<td class="col-name">' +
          '<input class="var-name-input" type="text" value="' + escHtml(v.name) +
          '" placeholder="VARIABLE_NAME" data-vi="' + i + '">' +
        '</td>' +
        '<td>' +
          '<input class="var-value-input" type="text" value="' + escHtml(v.value) +
          '" placeholder="value" data-vi="' + i + '">' +
        '</td>' +
        '<td class="col-actions">' +
          '<button class="remove-btn" data-vi="' + i + '" title="Delete">\xd7</button>' +
        '</td>';
      tbody.appendChild(tr);

      tr.querySelector('input[type=checkbox]').addEventListener('change', e => {
        variables[+e.target.dataset.vi].enabled = e.target.checked;
        persistVariables();
      });
      tr.querySelector('.var-name-input').addEventListener('input', e => {
        variables[+e.target.dataset.vi].name = e.target.value;
        persistVariables();
      });
      tr.querySelector('.var-value-input').addEventListener('input', e => {
        variables[+e.target.dataset.vi].value = e.target.value;
        persistVariables();
      });
      tr.querySelector('.remove-btn').addEventListener('click', e => {
        variables.splice(+e.target.dataset.vi, 1);
        persistVariables();
        renderVarsTable();
        refreshUrlPreview();
      });
    });
  }

  // ── Rescan ─────────────────────────────────────────────────────────────────────
  async function triggerRescan() {
    const btn = document.getElementById('reload-routes-btn');
    const rescanBtn = document.getElementById('rescan-btn');
    setScanSpinner(true);

    try {
      const data = await apiRescan();
      allRoutes = data.routes || [];
      seedBaseUrlVariable(data.baseUrl || 'http://localhost:3000');
      renderSidebar();

      // Show banner in panel
      const banner = document.getElementById('routes-updated-banner');
      const count  = document.getElementById('routes-updated-count');
      if (banner && count) {
        count.textContent = allRoutes.length + ' route' + (allRoutes.length !== 1 ? 's' : '') + ' detected';
        banner.classList.remove('hidden');
      }
    } catch (err) {
      console.error('[auto-detect-route] Rescan failed:', err);
    } finally {
      setScanSpinner(false);
    }
  }

  function setScanSpinner(active) {
    const btn = document.getElementById('reload-routes-btn');
    const rescanBtn = document.getElementById('rescan-btn');
    [btn, rescanBtn].forEach(b => {
      if (!b) return;
      if (active) { b.classList.add('spinning'); b.disabled = true; }
      else        { b.classList.remove('spinning'); b.disabled = false; }
    });
  }

  // ── Resizable sidebar ─────────────────────────────────────────────────────────
  function initResizeHandle() {
    const handle  = document.getElementById('resize-handle');
    const sidebar = document.querySelector('.app-sidebar');
    if (!handle || !sidebar) return;

    let dragging = false;
    let startX, startW;

    handle.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newW = Math.max(160, Math.min(480, startW + (e.clientX - startX)));
      sidebar.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function syntaxHighlight(json) {
    return escHtml(json).replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      function (match) {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'json-key' : 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-bool';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  // ── Init ───────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {

    // ── Tabs (request) ─────────────────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab)?.classList.remove('hidden');
      });
    });

    // ── Tabs (response) ────────────────────────────────────────────────────────
    document.querySelectorAll('.resp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.resp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.resp-panel').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById('resp-tab-' + btn.dataset.respTab)?.classList.remove('hidden');
      });
    });

    // ── Add query param ────────────────────────────────────────────────────────
    document.getElementById('add-query-btn')?.addEventListener('click', () => {
      queryParams.push({ key: '', value: '', enabled: true });
      renderQueryParams(); scheduleSave();
    });

    // ── Add header ─────────────────────────────────────────────────────────────
    document.getElementById('add-header-btn')?.addEventListener('click', () => {
      customHeaders.push({ key: '', value: '', enabled: true });
      renderHeaders(); scheduleSave();
    });

    // ── Bearer token ───────────────────────────────────────────────────────────
    document.getElementById('bearer-token')?.addEventListener('input', scheduleSave);
    document.getElementById('clear-bearer-btn')?.addEventListener('click', () => {
      document.getElementById('bearer-token').value = '';
      scheduleSave();
    });

    // ── Body ───────────────────────────────────────────────────────────────────
    document.getElementById('body-enabled')?.addEventListener('change', e => {
      document.getElementById('body-editor').disabled = !e.target.checked;
      scheduleSave();
    });
    document.getElementById('body-editor')?.addEventListener('input', scheduleSave);

    // ── Send button ────────────────────────────────────────────────────────────
    document.getElementById('send-btn')?.addEventListener('click', sendRequest);

    // ── URL bar: manual editing ────────────────────────────────────────────────
    const urlPreview = document.getElementById('url-preview');
    if (urlPreview) {
      urlPreview.addEventListener('input', () => {
        manualUrl = urlPreview.value;
        scheduleSave();
      });
      urlPreview.addEventListener('change', () => {
        if (!urlPreview.value.trim()) { manualUrl = null; refreshUrlPreview(); }
      });
      urlPreview.addEventListener('keydown', e => {
        if (e.key === 'Escape') { manualUrl = null; refreshUrlPreview(); urlPreview.blur(); }
      });
    }

    // ── Ctrl/Cmd + S → save ────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentState();
        flashSaved();
      }
    });

    // ── Reload routes (panel button) ───────────────────────────────────────────
    document.getElementById('reload-routes-btn')?.addEventListener('click', triggerRescan);

    // ── Rescan (header button) ─────────────────────────────────────────────────
    document.getElementById('rescan-btn')?.addEventListener('click', triggerRescan);

    // ── Copy source path ───────────────────────────────────────────────────────
    document.getElementById('goto-source-btn')?.addEventListener('click', () => {
      if (!currentRoute) return;
      const text = currentRoute.sourceFile + ':' + currentRoute.sourceLine;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          const btn = document.getElementById('goto-source-btn');
          if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 1500); }
        });
      }
    });

    // ── Dismiss banner ─────────────────────────────────────────────────────────
    document.getElementById('dismiss-banner-btn')?.addEventListener('click', () => {
      document.getElementById('routes-updated-banner')?.classList.add('hidden');
    });

    // ── Filter ─────────────────────────────────────────────────────────────────
    document.getElementById('filter-input')?.addEventListener('input', e => {
      filterText = e.target.value.toLowerCase().trim();
      renderSidebar();
    });

    // ── Group by ───────────────────────────────────────────────────────────────
    document.getElementById('group-file-btn')?.addEventListener('click', () => {
      groupBy = 'file';
      localStorage.setItem('adr_groupBy', groupBy);
      document.getElementById('group-file-btn').classList.add('active');
      document.getElementById('group-method-btn').classList.remove('active');
      renderSidebar();
    });
    document.getElementById('group-method-btn')?.addEventListener('click', () => {
      groupBy = 'method';
      localStorage.setItem('adr_groupBy', groupBy);
      document.getElementById('group-method-btn').classList.add('active');
      document.getElementById('group-file-btn').classList.remove('active');
      renderSidebar();
    });
    // Restore groupBy active state
    if (groupBy === 'method') {
      document.getElementById('group-method-btn')?.classList.add('active');
      document.getElementById('group-file-btn')?.classList.remove('active');
    }

    // ── Variables modal ────────────────────────────────────────────────────────
    document.getElementById('open-vars-btn')?.addEventListener('click', openVarsModal);
    document.getElementById('close-vars-btn')?.addEventListener('click', closeVarsModal);
    document.getElementById('vars-modal-backdrop')?.addEventListener('click', closeVarsModal);

    document.getElementById('add-var-btn')?.addEventListener('click', () => {
      variables.push({ name: '', value: '', enabled: true });
      persistVariables();
      renderVarsTable();
    });

    // Close modal on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('vars-modal');
        if (modal && !modal.classList.contains('hidden')) closeVarsModal();
      }
    });

    // ── Resize handle ──────────────────────────────────────────────────────────
    initResizeHandle();

    // ── Load routes on startup ─────────────────────────────────────────────────
    scanning = true;
    apiFetchRoutes()
      .then(data => {
        allRoutes = data.routes || [];
        scanning  = data.scanning || false;
        // Seed BASE_URL variable from server config (only if not already set by user)
        seedBaseUrlVariable(data.baseUrl || 'http://localhost:3000');
        renderSidebar();

        // If still scanning server-side, poll once more after 2 seconds
        if (data.scanning) {
          setTimeout(() => {
            apiFetchRoutes().then(d => {
              allRoutes = d.routes || [];
              scanning  = false;
              renderSidebar();
            }).catch(() => { scanning = false; renderSidebar(); });
          }, 2000);
        }
      })
      .catch(err => {
        scanning = false;
        const list = document.getElementById('route-list');
        if (list) {
          list.innerHTML = '<div class="sidebar-empty">Failed to load routes.<br><small>' +
            escHtml(err.message) + '</small></div>';
        }
      });
  });

}());
