const Utils = {
  MONTHLY_HOURS: 160, // horas laborales estándar por mes (8h × 20 días hábiles)

  fmt(n, decimals = 0) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },

  fmtMoney(n, currency = 'COP') {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('es-MX', { style: 'currency', currency, minimumFractionDigits: 2 });
  },

  fmtPercent(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toFixed(1) + '%';
  },

  fmtHours(n) {
    if (!n) return '0h';
    const h = Math.floor(n);
    const m = Math.round((n - h) * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  },

  avatarColor(str) {
    const colors = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#06b6d4'];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  },

  initials(name) {
    if (!name) return '?';
    return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  },

  formatPeriod(p) {
    if (!p) return '—';
    const [y, m] = p.split('-');
    const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return `${names[(parseInt(m) || 1) - 1]} ${y}`;
  },

  // Determine project type: explicit stored value, or auto-detect from workspace/board name
  resolveType(storedType, workspaceName, boardName) {
    if (storedType === 'retencion' || storedType === 'unico') return storedType;
    const text = `${workspaceName || ''} ${boardName || ''}`.toLowerCase();
    if (/mercadeo|marketing|retenci|mensual|social\s*media|community/i.test(text)) return 'retencion';
    return 'unico';
  },

  typeLabel(type) {
    return type === 'retencion' ? '♻️ Retención' : type === 'unico' ? '📦 Único' : '';
  },

  typeColor(type) {
    return type === 'retencion' ? '#06b6d4' : '#8b5cf6';
  },

  autoDetectPeriod(name, fallbackDate) {
    const MAP = {
      enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',
      julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12',
      ene:'01',feb:'02',mar:'03',abr:'04',may:'05',jun:'06',
      jul:'07',ago:'08',sep:'09',oct:'10',nov:'11',dic:'12'
    };
    const lower = name.toLowerCase();
    const yearM = name.match(/\b(202\d|203\d)\b/);
    const year  = yearM ? yearM[1] : (fallbackDate ? String(new Date(fallbackDate).getFullYear()) : null);
    let month = null;
    for (const [word, num] of Object.entries(MAP)) {
      if (lower.includes(word)) { month = num; break; }
    }
    if (year && month) return `${year}-${month}`;
    if (fallbackDate) {
      const d = new Date(fallbackDate);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return '';
  },

  categoryColor(str) {
    if (!str) return '#6366f1';
    const colors = ['#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316','#84cc16'];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  },

  progressColor(pct) {
    if (pct >= 75) return 'green';
    if (pct >= 40) return 'yellow';
    return 'red';
  },

  roiColor(roi) {
    if (roi === null || roi === undefined || isNaN(roi)) return '';
    if (roi >= 0) return 'text-success';
    return 'text-danger';
  },

  timeSince(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'hace unos segundos';
    if (diff < 3600) return `hace ${Math.floor(diff/60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff/3600)} h`;
    if (diff < 2592000) return `hace ${Math.floor(diff/86400)} días`;
    return `hace ${Math.floor(diff/2592000)} meses`;
  },

  getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  },

  requireAuth(redirectUrl = 'configuracion.html') {
    if (!Storage.hasCredentials()) {
      window.location.href = redirectUrl;
      return false;
    }
    return true;
  },

  showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    const colors = { info: '#3b82f6', success: '#10b981', danger: '#ef4444', warning: '#f59e0b' };
    toast.style.cssText = `
      position:fixed; bottom:20px; right:20px; z-index:999;
      background:${colors[type]}; color:#fff; padding:12px 18px;
      border-radius:10px; font-size:0.875rem; font-weight:500;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);
      animation: slideIn 0.3s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },

  calcROI(revenue, cost) {
    if (!cost || cost === 0) return null;
    return ((revenue - cost) / cost) * 100;
  },

  calcCost(hoursSpent, monthlySalary) {
    return hoursSpent * (monthlySalary / this.MONTHLY_HOURS);
  },

  // Attach click-to-sort on all <th> in a table's <thead>.
  // Handles paired rows (main row + detail row with data-detail="true").
  makeSortable(tableEl) {
    if (!tableEl || tableEl.dataset.sortable) return;
    tableEl.dataset.sortable = 'true';
    const ths = tableEl.querySelectorAll('thead th');
    ths.forEach((th, colIdx) => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      th.title = 'Clic para ordenar';
      const ind = document.createElement('span');
      ind.className = 'sort-ind';
      ind.style.cssText = 'margin-left:5px;opacity:0.35;font-size:0.7em;transition:opacity 0.15s';
      ind.textContent = '⇅';
      th.appendChild(ind);
      th._sortDir = null;
      th.addEventListener('click', () => {
        const dir = th._sortDir === 'asc' ? 'desc' : 'asc';
        ths.forEach(h => {
          h._sortDir = null;
          const i = h.querySelector('.sort-ind');
          if (i) { i.textContent = '⇅'; i.style.opacity = '0.35'; }
        });
        th._sortDir = dir;
        ind.textContent = dir === 'asc' ? '▲' : '▼';
        ind.style.opacity = '1';
        this._sortTableByCol(tableEl, colIdx, dir);
      });
    });
  },

  _sortTableByCol(tableEl, colIdx, dir) {
    const tbody = tableEl.querySelector('tbody');
    if (!tbody) return;
    const allRows = Array.from(tbody.rows);
    // Group main rows with their optional detail row (data-detail="true")
    const groups = [];
    let i = 0;
    while (i < allRows.length) {
      const row = allRows[i];
      if (row.dataset.detail) { i++; continue; }
      const group = [row];
      if (allRows[i + 1]?.dataset.detail) group.push(allRows[++i]);
      groups.push(group);
      i++;
    }
    const cellText = row => {
      const cell = row.cells[colIdx];
      if (!cell) return '';
      const inp = cell.querySelector('input, select');
      return (inp ? inp.value : cell.textContent).trim();
    };
    const parse = str => {
      // Hours: "7h 20m"
      const hm = str.match(/(\d+)h\s*(\d*)m?/);
      if (hm) return +hm[1] + (+hm[2] || 0) / 60;
      // Percentage: "75.3%"
      const pm = str.match(/(-?[\d.,]+)%/);
      if (pm) return parseFloat(pm[1].replace(',', '.'));
      // Number / currency — strip letters, spaces, currency symbols
      let s = str.replace(/[a-zA-Z$€£¥₩\s]/g, '');
      // European decimal comma: "1.234,56" → "1234.56"
      if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, ''); // American: remove thousands commas
      const n = parseFloat(s);
      if (!isNaN(n)) return n;
      return str.toLowerCase();
    };
    groups.sort((a, b) => {
      const va = parse(cellText(a[0]));
      const vb = parse(cellText(b[0]));
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    groups.forEach(g => g.forEach(r => tbody.appendChild(r)));
  }
};

window.Utils = Utils;
