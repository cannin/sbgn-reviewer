let files = [];
let currentIndex = 0;
let editor = null;

const fileListEl = document.getElementById('fileList');
const currentFileEl = document.getElementById('currentFile');
const fileCounterEl = document.getElementById('fileCounter');
const oldImageEl = document.getElementById('oldImage');
const newImageEl = document.getElementById('newImage');
const acceptBtn = document.getElementById('acceptBtn');
const rejectBtn = document.getElementById('rejectBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const copyBtn = document.getElementById('copyBtn');
const toggleFilesBtn = document.getElementById('toggleFilesBtn');
const toggleFilesTopBtn = document.getElementById('toggleFilesTopBtn');
const filesCol = document.getElementById('filesCol');
const xmlCol = document.getElementById('xmlCol');
const saveToast = document.getElementById('saveToast');
const copyToast = document.getElementById('copyToast');
let toastTimer = null;
let copyToastTimer = null;
const panzoomInstances = new Map();
let filesCollapsed = false;

function initEditor() {
  editor = CodeMirror.fromTextArea(document.getElementById('xmlEditor'), {
    mode: 'application/xml',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true
  });
  editor.setSize('100%', '100%');
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error('Request failed');
  }
  return response.json();
}

function setCounter() {
  const acceptCount = files.filter((file) => file.status === 'accept').length;
  const rejectCount = files.filter((file) => file.status === 'reject').length;
  const clearCount = files.length - acceptCount - rejectCount;
  fileCounterEl.textContent = `${files.length} files (${acceptCount} accept, ${rejectCount} reject, ${clearCount} clear)`;
}

function statusClass(status) {
  if (status === 'accept') return 'status-accept';
  if (status === 'reject') return 'status-reject';
  return '';
}

function renderFileList() {
  fileListEl.innerHTML = '';
  files.forEach((file, index) => {
    const item = document.createElement('li');
    item.className = `list-group-item file-item ${statusClass(file.status)}`;
    if (index === currentIndex) {
      item.classList.add('selected');
    }
    item.textContent = file.base;
    item.addEventListener('click', () => selectIndex(index));
    fileListEl.appendChild(item);
  });
  setCounter();
}

function scrollSelectedIntoView() {
  const selected = fileListEl.querySelector('.file-item.selected');
  if (!selected) return;
  selected.scrollIntoView({ block: 'nearest' });
}

async function loadFile(index) {
  const file = files[index];
  if (!file) return;

  currentFileEl.textContent = file.base;
  oldImageEl.src = `/api/image/old/${encodeURIComponent(file.base)}`;
  newImageEl.src = `/api/image/new/${encodeURIComponent(file.base)}`;

  const data = await fetchJson(`/api/file/${encodeURIComponent(file.base)}`);
  editor.setValue(data.xml || '');
  file.status = data.status ?? null;
  renderFileList();
}

function selectIndex(index) {
  if (files.length === 0) {
    return;
  }
  const clamped = Math.min(Math.max(index, 0), files.length - 1);
  if (clamped === currentIndex && editor.getValue()) {
    return;
  }
  currentIndex = clamped;
  renderFileList();
  loadFile(currentIndex);
  scrollSelectedIntoView();
}

async function saveCurrent() {
  const file = files[currentIndex];
  if (!file) return;

  await fetchJson('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: file.base, xml: editor.getValue() })
  });
  showToast();
}

async function setStatus(status) {
  const file = files[currentIndex];
  if (!file) return;

  await fetchJson('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: file.base, status })
  });

  file.status = status;
  renderFileList();
}

function handleKeydown(event) {
  const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
  if (isSave) {
    event.preventDefault();
    saveCurrent();
    return;
  }

  const isInEditor = editor && editor.hasFocus();
  if (!isInEditor) {
    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      setStatus('accept');
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      setStatus('reject');
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      setStatus(null);
      return;
    }
  }

  if (isInEditor) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectIndex(currentIndex + 1);
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectIndex(currentIndex - 1);
  }
}

async function init() {
  initEditor();
  setupPanzoom(oldImageEl);
  setupPanzoom(newImageEl);
  const data = await fetchJson('/api/files');
  files = data.files || [];
  setCounter();
  renderFileList();
  if (files.length > 0) {
    selectIndex(0);
  }

  acceptBtn.addEventListener('click', () => setStatus('accept'));
  rejectBtn.addEventListener('click', () => setStatus('reject'));
  clearBtn.addEventListener('click', () => setStatus(null));
  saveBtn.addEventListener('click', saveCurrent);
  copyBtn.addEventListener('click', copyXml);
  toggleFilesBtn.addEventListener('click', toggleFilesColumn);
  toggleFilesTopBtn.addEventListener('click', toggleFilesColumn);
  document.addEventListener('keydown', handleKeydown);
  const closeBtn = saveToast.querySelector('.btn-close');
  closeBtn.addEventListener('click', () => hideToast());
  const copyCloseBtn = copyToast.querySelector('.btn-close');
  copyCloseBtn.addEventListener('click', () => hideCopyToast());
}

init();

function showToast() {
  if (!saveToast) return;
  saveToast.classList.add('show');
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    hideToast();
  }, 2000);
}

function hideToast() {
  if (!saveToast) return;
  saveToast.classList.remove('show');
}

function setupPanzoom(imgEl) {
  if (!imgEl || typeof Panzoom !== 'function') return;
  if (!panzoomInstances.has(imgEl)) {
    const instance = Panzoom(imgEl, { maxScale: 6, minScale: 1 });
    panzoomInstances.set(imgEl, instance);
    const parent = imgEl.parentElement;
    if (parent) {
      parent.addEventListener('wheel', instance.zoomWithWheel);
      parent.addEventListener('dblclick', (event) => {
        event.preventDefault();
        instance.reset();
      });
    }
  }

  imgEl.addEventListener('load', () => {
    const instance = panzoomInstances.get(imgEl);
    if (instance) {
      instance.reset();
    }
  });
}

async function copyXml() {
  if (!editor) return;
  const text = editor.getValue();
  if (!navigator.clipboard) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showCopyToast();
  } catch (err) {
    // No-op when clipboard is blocked.
  }
}

function showCopyToast() {
  if (!copyToast) return;
  copyToast.classList.add('show');
  if (copyToastTimer) {
    clearTimeout(copyToastTimer);
  }
  copyToastTimer = setTimeout(() => {
    hideCopyToast();
  }, 2000);
}

function hideCopyToast() {
  if (!copyToast) return;
  copyToast.classList.remove('show');
}

function toggleFilesColumn() {
  filesCollapsed = !filesCollapsed;
  if (filesCollapsed) {
    filesCol.classList.add('d-none');
    xmlCol.classList.remove('col-lg-4');
    xmlCol.classList.add('col-lg-7');
    toggleFilesBtn.textContent = 'Show';
    toggleFilesTopBtn.classList.remove('d-none');
  } else {
    filesCol.classList.remove('d-none');
    xmlCol.classList.remove('col-lg-7');
    xmlCol.classList.add('col-lg-4');
    toggleFilesBtn.textContent = 'Collapse';
    toggleFilesTopBtn.classList.add('d-none');
  }
}
