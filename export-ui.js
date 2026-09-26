/**
 * export-ui.js
 * Shared pieces of the export panels (main window and Recording Viewer):
 * format checkboxes, the list of saved files, and saving through whichever
 * platform is running — the Windows app (window.desktop), the Android app
 * (window.mobile, from mobile-bridge.js) or a plain browser (downloads).
 *
 *   ExportUI.renderFormatGrid(gridEl, formats, selectedIds, onChange)
 *     formats with a "group" get group headings; long lists get "Select all" and "Clear"
 *   ExportUI.checkedIds(gridEl)
 *   ExportUI.renderResults(listEl, results)   // "Show in folder" / "Share" buttons
 *   await ExportUI.saveFiles({ title, baseName, files })
 *     -> { dir, results } | { canceled: true } | { downloaded: true, count }
 */

(function (global) {
  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Checkbox grid. formats: [{ id, label, detail, available?, why?, group? }]. If none
  // of the selected ids is available, the first available format is checked instead.
  function renderFormatGrid(grid, formats, selectedIds, onChange) {
    const usable = formats.filter((f) => f.available !== false);
    const anySelected = usable.some((f) => selectedIds.includes(f.id));
    const changed = () => onChange && onChange(checkedIds(grid));
    grid.innerHTML = "";
    if (usable.length > 8) {
      const tools = document.createElement("div");
      tools.className = "format-tools";
      for (const [text, on] of [["Select all", true], ["Clear", false]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.addEventListener("click", () => {
          for (const input of grid.querySelectorAll("input:not(:disabled)")) input.checked = on;
          changed();
        });
        tools.appendChild(b);
      }
      grid.appendChild(tools);
    }
    const grouped = new Set(formats.map((f) => f.group).filter(Boolean)).size > 1;
    let group = null;
    for (const f of formats) {
      if (grouped && f.group !== group) {
        group = f.group;
        const heading = document.createElement("div");
        heading.className = "format-group";
        heading.textContent = group;
        grid.appendChild(heading);
      }
      const available = f.available !== false;
      const label = document.createElement("label");
      label.className = `format-option${available ? "" : " unavailable"}`;
      if (f.why) label.title = f.why;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = f.id;
      input.disabled = !available;
      input.checked = available && (anySelected ? selectedIds.includes(f.id) : usable[0] === f);
      input.addEventListener("change", changed);
      const text = document.createElement("span");
      text.textContent = f.label;
      const small = document.createElement("small");
      small.textContent = f.detail;
      text.appendChild(small);
      label.append(input, text);
      grid.appendChild(label);
    }
  }

  function checkedIds(grid) {
    return [...grid.querySelectorAll("input:checked")].map((i) => i.value);
  }

  function renderResults(list, results) {
    const desktop = global.desktop || null;
    const mobile = global.mobile || null;
    list.innerHTML = "";
    for (const r of results) {
      const li = document.createElement("li");
      li.className = r.ok ? "ok" : "fail";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = r.ok ? "✓" : "✕";
      const name = document.createElement("span");
      name.className = "name";
      if (r.ok) {
        const fileName = r.path.split(/[\\/]/).pop();
        let shown = fileName;
        try {
          shown = decodeURIComponent(fileName); // Android returns file:// URIs
        } catch {
          // keep as-is
        }
        name.textContent = `${shown} · ${formatBytes(r.size)}`;
        name.title = r.path;
      } else {
        name.textContent = `${String(r.format).toUpperCase()}: ${r.error}`;
      }
      li.append(mark, name);
      if (r.ok && desktop) {
        const show = document.createElement("button");
        show.textContent = "Show in folder";
        show.addEventListener("click", () => desktop.showInFolder(r.path));
        li.appendChild(show);
      } else if (r.ok && mobile) {
        const share = document.createElement("button");
        share.textContent = "Share";
        share.addEventListener("click", () => mobile.share(r.path).catch(() => {}));
        li.appendChild(share);
      }
      list.appendChild(li);
    }
  }

  // files: [{ format, suffix, ext, data: string | Uint8Array }]
  async function saveFiles({ title, baseName, files }) {
    const native = global.desktop || global.mobile;
    if (native) return native.saveFiles({ title, baseName, files });
    for (const f of files) downloadBlob(new Blob([f.data]), `${baseName}${f.suffix || ""}.${f.ext}`);
    return { downloaded: true, count: files.length };
  }

  global.ExportUI = { renderFormatGrid, checkedIds, renderResults, saveFiles, formatBytes, downloadBlob };
})(window);
