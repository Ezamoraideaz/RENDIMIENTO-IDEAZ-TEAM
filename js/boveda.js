// Controlador de boveda.html — habla con backend/api/vault.php.
// Reglas: los secretos nunca se guardan en variables globales ni en localStorage;
// viven solo en la ventana abierta y se borran al cerrarla o a los 5 minutos.
(() => {
  const CATEGORIES = { social: 'Red social', web: 'Web', hosting: 'Hosting', dominio: 'Dominio', correo: 'Correo', plataforma: 'Plataforma', otro: 'Otro' };
  const ACTIONS = { create: 'Creó', view: 'Consultó', open_edit: 'Abrió para editar', update: 'Editó', delete: 'Borró', restore: 'Restauró', enroll: 'Activó autenticador', code_fail: 'Código errado' };
  const VISIBLE_SECONDS = 300;

  let items = [];
  let brands = [];
  let enrolled = false;
  let failures = 0;
  let timer = null;
  let clipTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const isSuper = () => Session.user.role === 'superadmin';
  const canEdit = () => isSuper() || Session.user.role === 'admin';
  const post = (body) => Session.apiFetch('api/vault.php', { method: 'POST', body: JSON.stringify(body) });
  const when = (utc) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

  // ── Ventana ────────────────────────────────────────────────────────────────
  const dialog = () => $('bv-dialog');

  function closeDialog() {
    clearInterval(timer);
    dialog().close();
    dialog().innerHTML = '';
    dialog().className = 'bento-card';
  }

  function openDialog(html, wide) {
    clearInterval(timer);
    const d = dialog();
    d.className = 'bento-card' + (wide ? ' is-wide' : '');
    d.innerHTML = html;
    if (!d.open) d.showModal();
    d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDialog));
    return d;
  }

  const foot = (submitLabel) => `
    <p class="bv-error" hidden></p>
    <div class="bv-foot">
      <button type="button" class="ui-chip" data-close>${submitLabel ? 'Cancelar' : 'Cerrar'}</button>
      ${submitLabel ? `<button type="submit" class="ui-chip ui-chip-primary">${submitLabel}</button>` : ''}
    </div>`;

  // Formulario en ventana: bloquea el doble envío y muestra el error sin cerrar
  function openForm(html, onSubmit) {
    const form = openDialog(`<form autocomplete="off">${html}</form>`).querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const err = form.querySelector('.bv-error');
      btn.disabled = true;
      err.hidden = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
        const code = form.querySelector('[name=code]');
        if (code) code.value = '';
      }
    });
  }

  // ── Listado ────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const data = await Session.apiFetch('api/vault.php');
      items = data.items;
      brands = data.brands;
      enrolled = data.enrolled;
      failures = data.failures || 0;
    } catch (e) {
      $('bv-list').textContent = e.message;
      return;
    }
    const notes = [];
    if (isSuper() && !enrolled) notes.push('Activa tu autenticador (botón "Mi autenticador") para poder consultar accesos y autorizar a tu equipo.');
    if (failures) notes.push(`Hubo ${failures} código(s) errado(s) en las últimas 24 horas. Revisa el Registro para ver quién lo intentó.`);
    const banner = $('bv-banner');
    banner.hidden = !notes.length;
    banner.textContent = notes.join(' ');
    const current = $('bv-brand').value;
    const used = [...new Set(items.map((i) => i.brand_name))];
    $('bv-brand').innerHTML = '<option value="">Todas las marcas</option>' + used.map((b) => `<option>${esc(b)}</option>`).join('');
    $('bv-brand').value = used.includes(current) ? current : '';
    render();
  }

  function render() {
    const q = $('bv-q').value.trim().toLowerCase();
    const brand = $('bv-brand').value;
    const cat = $('bv-cat').value;
    const rows = items.filter((i) => (!brand || i.brand_name === brand) && (!cat || i.category === cat)
      && (!q || `${i.brand_name} ${i.title} ${i.url} ${i.owner}`.toLowerCase().includes(q)));
    $('bv-count').textContent = `${rows.length} de ${items.length}`;
    $('bv-list').innerHTML = rows.length ? `
      <table class="bv-table" data-tv="off">
        <thead><tr><th>Marca</th><th>Tipo</th><th>Plataforma</th><th>URL</th><th>Responsable</th><th></th></tr></thead>
        <tbody>${rows.map((i) => `
          <tr>
            <td><b>${esc(i.brand_name)}</b></td>
            <td>${esc(CATEGORIES[i.category] || i.category)}</td>
            <td>${esc(i.title)}</td>
            <td>${/^https?:\/\//i.test(i.url) ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.url)}</a>` : ''}</td>
            <td>${esc(i.owner)}</td>
            <td><div class="bv-row-actions" data-id="${Number(i.id)}">
              <button type="button" class="ui-chip" data-row="view">Ver</button>
              ${canEdit() ? '<button type="button" class="ui-chip" data-row="edit">Editar</button><button type="button" class="ui-chip bv-danger" data-row="delete">Borrar</button>' : ''}
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<p class="bv-muted">${items.length ? 'Nada coincide con la búsqueda.' : 'Todavía no hay accesos guardados.'}</p>`;
  }

  // ── Pedir código ───────────────────────────────────────────────────────────
  function askCode(item, title, submitLabel, onSubmit) {
    openForm(`
      <h2>${esc(title)}</h2>
      <p class="bv-muted">${esc(item.brand_name)} · ${esc(item.title)}</p>
      ${isSuper() ? '' : '<label class="bv-field">Motivo<input class="bv-input" name="reason" required minlength="5" maxlength="300" placeholder="Ej. responder mensajes de la marca"></label>'}
      <label class="bv-field">${isSuper() ? 'Código de tu autenticador (o de recuperación)' : 'Código que te da el superadmin'}
        <input class="bv-input bv-otp" name="code" required maxlength="20" inputmode="${isSuper() ? 'text' : 'numeric'}" autocomplete="one-time-code">
      </label>
      ${foot(submitLabel)}`, onSubmit);
  }

  function viewItem(item) {
    askCode(item, 'Ver acceso', 'Ver', async (data) => {
      const { secrets } = await post({ action: 'reveal', id: item.id, ...data });
      showSecrets(item, secrets);
    });
  }

  function showSecrets(item, secrets) {
    const row = (label, key, masked) => `
      <label class="bv-field">${label}
        <span class="bv-inline">
          <input class="bv-input bv-code" readonly type="${masked ? 'password' : 'text'}" data-field="${key}">
          ${masked ? '<button type="button" class="ui-chip" data-toggle>Mostrar</button>' : ''}
          <button type="button" class="ui-chip" data-copy>Copiar</button>
        </span>
      </label>`;
    const d = openDialog(`
      <h2>${esc(item.title)}</h2>
      <p class="bv-muted">${esc(item.brand_name)} · se cierra en <b id="bv-left"></b></p>
      ${row('Usuario', 'username')}
      ${row('Contraseña', 'password', true)}
      <label class="bv-field">Notas y códigos de respaldo<textarea class="bv-input" rows="4" readonly data-field="notes"></textarea></label>
      ${foot()}`);
    d.querySelectorAll('[data-field]').forEach((el) => { el.value = secrets[el.dataset.field] || ''; });
    d.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.parentElement.querySelector('input').value);
        b.textContent = 'Copiado (30 s)';
        // Vacía el portapapeles a los 30 s (el navegador solo lo permite si la pestaña está activa)
        clearTimeout(clipTimer);
        clipTimer = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000);
      } catch (e) {
        b.textContent = 'No se pudo';
      }
    }));
    d.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const input = b.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      b.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
    }));
    startCountdown(VISIBLE_SECONDS);
  }

  // Cierra la ventana al vencer (usa la hora real: sigue contando con la pestaña en segundo plano)
  function startCountdown(seconds) {
    const end = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.round((end - Date.now()) / 1000);
      if (left <= 0) return closeDialog();
      const el = $('bv-left');
      if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  // ── Crear / editar / borrar ────────────────────────────────────────────────
  function itemForm(item, secrets) {
    const v = { ...item, ...secrets };
    const field = (label, name, attrs = '') => `<label class="bv-field">${label}<input class="bv-input" name="${name}" value="${esc(v[name])}" ${attrs}></label>`;
    openForm(`
      <h2>${item ? 'Editar acceso' : 'Nuevo acceso'}</h2>
      ${item ? '<p class="bv-muted">Tienes <b id="bv-left"></b> para guardar.</p>' : ''}
      ${field('Marca', 'brand_name', 'required maxlength="150" list="bv-brands"')}
      <datalist id="bv-brands">${brands.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      <label class="bv-field">Tipo<select class="bv-input" name="category">${Object.entries(CATEGORIES).map(([k, l]) => `<option value="${k}" ${v.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${field('Plataforma o nombre del acceso', 'title', 'required maxlength="190" placeholder="Ej. Instagram, cPanel, GoDaddy"')}
      ${field('URL', 'url', 'maxlength="500"')}
      ${field('Responsable', 'owner', 'maxlength="150"')}
      ${field('Usuario', 'username', 'maxlength="300" autocomplete="off"')}
      <label class="bv-field">Contraseña
        <span class="bv-inline">
          <input class="bv-input bv-code" type="password" name="password" value="${esc(v.password)}" maxlength="500" autocomplete="new-password">
          <button type="button" class="ui-chip" id="bv-show">Mostrar</button>
        </span>
      </label>
      <label class="bv-field">Notas y códigos de respaldo<textarea class="bv-input" name="notes" rows="3" maxlength="3000">${esc(v.notes)}</textarea></label>
      ${foot('Guardar')}`, async (data) => {
      await post({ action: item ? 'update' : 'create', id: item?.id, ...data });
      closeDialog();
      await load();
    });
    $('bv-show').addEventListener('click', (e) => {
      const input = dialog().querySelector('[name=password]');
      input.type = input.type === 'password' ? 'text' : 'password';
      e.target.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
    });
    if (item) startCountdown(VISIBLE_SECONDS);
  }

  function editItem(item) {
    askCode(item, 'Editar acceso', 'Continuar', async (data) => {
      const { secrets } = await post({ action: 'reveal', purpose: 'edit', id: item.id, ...data });
      itemForm(item, secrets);
    });
  }

  function deleteItem(item) {
    askCode(item, 'Borrar acceso (queda 30 días en la papelera)', 'Borrar', async (data) => {
      await post({ action: 'delete', id: item.id, ...data });
      closeDialog();
      await load();
    });
  }

  // ── Solo superadmin ────────────────────────────────────────────────────────
  function enroll() {
    openForm(`
      <h2>${enrolled ? 'Cambiar de autenticador' : 'Activar mi autenticador'}</h2>
      <p class="bv-muted">Necesitas Google Authenticator o Microsoft Authenticator en tu celular.</p>
      <label class="bv-field">Tu contraseña del dashboard<input class="bv-input" type="password" name="password" required autocomplete="current-password"></label>
      ${enrolled ? '<label class="bv-field">Código actual o de recuperación<input class="bv-input" name="code" required maxlength="20"></label>' : ''}
      ${foot('Continuar')}`, async (data) => {
      const res = await post({ action: 'enroll_start', ...data });
      openForm(`
        <h2>Agrega la cuenta en tu app</h2>
        <p class="bv-muted">En la app elige <b>Ingresar clave de configuración</b>, tipo "Basada en tiempo", y escribe:</p>
        <p class="bv-field">Nombre de la cuenta</p><p>IDEAZ Accesos</p>
        <p class="bv-field">Clave</p><p class="bv-code">${esc(res.secret.match(/.{1,4}/g).join(' '))}</p>
        <p class="bv-muted">¿Estás en el celular? <a href="${esc(res.uri)}"><u>Abrir en la app</u></a></p>
        <label class="bv-field">Código de 6 dígitos que muestra la app<input class="bv-input bv-otp" name="code" required maxlength="7" inputmode="numeric"></label>
        ${foot('Activar')}`, async (confirm) => {
        const done = await post({ action: 'enroll_confirm', ...confirm });
        openDialog(`
          <h2>Guarda estos códigos de recuperación</h2>
          <p class="bv-muted">Anótalos en papel y guárdalos en un lugar seguro. Cada uno sirve una vez si pierdes el celular. <b>No se vuelven a mostrar.</b></p>
          <p class="bv-code">${done.recovery.map(esc).join('<br>')}</p>
          ${foot()}`);
        load();
      });
    });
  }

  async function showAudit() {
    const d = openDialog('<h2>Registro de actividad</h2><p class="bv-muted">Cargando…</p>', true);
    try {
      const { audit } = await Session.apiFetch('api/vault.php?view=audit');
      openDialog(`
        <h2>Registro de actividad</h2>
        <p class="bv-muted">Últimos 500 movimientos, hora de Bogotá.</p>
        <div class="bv-table-box"><table class="bv-table" data-tv="off">
          <thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Acceso</th><th>Motivo</th><th>Código de</th><th>IP</th></tr></thead>
          <tbody>${audit.map((a) => `<tr>
            <td>${esc(when(a.created_at))}</td><td>${esc(a.operator_name)}</td>
            <td class="${a.action === 'code_fail' ? 'bv-danger' : ''}">${esc(ACTIONS[a.action] || a.action)}</td>
            <td>${esc(a.item_label)}</td><td>${esc(a.reason)}</td><td>${esc(a.approver_name)}</td><td>${esc(a.ip)}</td></tr>`).join('')}
          </tbody></table></div>
        ${foot()}`, true);
    } catch (e) {
      d.querySelector('p').textContent = e.message;
    }
  }

  async function showTrash() {
    let list = [];
    let error = '';
    try {
      list = (await Session.apiFetch('api/vault.php?view=trash')).items;
    } catch (e) {
      error = e.message;
    }
    const d = openDialog(`
      <h2>Papelera</h2>
      <p class="bv-muted">${esc(error) || 'Se eliminan definitivamente a los 30 días.'}</p>
      <table class="bv-table" data-tv="off"><tbody>${list.map((i) => `
        <tr><td><b>${esc(i.brand_name)}</b> · ${esc(i.title)}<br><span class="bv-muted">Borrado ${esc(when(i.deleted_at))}</span></td>
        <td><button type="button" class="ui-chip" data-restore="${Number(i.id)}">Restaurar</button></td></tr>`).join('')}
      </tbody></table>
      ${foot()}`);
    d.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await post({ action: 'restore', id: Number(b.dataset.restore) });
        await load();
        showTrash();
      } catch (e) {
        b.textContent = e.message;
      }
    }));
  }

  // ── Inicio ─────────────────────────────────────────────────────────────────
  Session.ready.then(() => {
    Sidebar.init('boveda');
    // sidebar.js usa onclick en línea para salir, que la política de seguridad bloquea
    document.querySelector('.ideaz-logout')?.addEventListener('click', () => Session.logout());

    if (isSuper()) document.querySelectorAll('.bv-super').forEach((b) => { b.hidden = false; });
    $('bv-cat').innerHTML = '<option value="">Todos los tipos</option>' + Object.entries(CATEGORIES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
    ['bv-q', 'bv-brand', 'bv-cat'].forEach((id) => $(id).addEventListener('input', render));

    const actions = { new: () => itemForm(null, null), enroll, audit: showAudit, trash: showTrash };
    $('bv-actions').addEventListener('click', (e) => actions[e.target.closest('[data-action]')?.dataset.action]?.());

    const rowActions = { view: viewItem, edit: editItem, delete: deleteItem };
    $('bv-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-row]');
      if (!btn) return;
      const item = items.find((i) => Number(i.id) === Number(btn.parentElement.dataset.id));
      if (item) rowActions[btn.dataset.row](item);
    });
    // Escape también debe borrar los datos de la ventana
    dialog().addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
    load();
  });
})();
