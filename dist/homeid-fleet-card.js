/* homeid-fleet-card.js — karta Lovelace do zarządzania flotą urządzeń HomeID.
 *
 * Listuje wszystkie urządzenia z rejestru HA, których producent (manufacturer)
 * to "HomeID" (trafiają tam przez MQTT discovery firmware'u), pokazując model,
 * wersję firmware (dev.sw z discovery), uptime, stan online/offline i status
 * OTA. Z poziomu listy można odpalić aktualizację pojedynczego urządzenia albo
 * zaznaczyć wiele — wtedy karta wykonuje je SEKWENCYJNIE (jedno po drugim):
 * naciska przycisk "Zainstaluj aktualizacje" (publish na homeid/<id>/update/set),
 * obserwuje sensor "Status aktualizacji" (homeid/<id>/ota/state:
 * downloading / up to date / failed(n) / no wifi), dostępność (LWT
 * homeid/<id>/status) i wersję z rejestru urządzeń, a do następnego przechodzi
 * dopiero po zakończeniu bieżącej aktualizacji.
 *
 * Tabela ma sortowanie (klik w nagłówek kolumny) i wyszukiwarkę filtrującą
 * po nazwie, modelu, chip ID, IP i wersji.
 *
 * Instalacja:
 *   1. Skopiuj ten plik do /config/www/homeid-fleet-card.js
 *   2. Ustawienia -> Dashboardy -> Zasoby -> Dodaj:
 *        URL: /local/homeid-fleet-card.js   typ: Moduł JavaScript
 *   3. Dodaj kartę na dashboard:
 *        type: custom:homeid-fleet-card
 *        title: HomeID — flota          # opcjonalne
 *        timeout: 300                   # s na jedno urządzenie (domyślnie 300)
 *        settle: 5                      # s przerwy między urządzeniami
 *        stop_on_error: false           # true = przerwij kolejkę po błędzie
 *        manufacturer: HomeID           # filtr rejestru urządzeń
 *
 * Uwaga: kolejka aktualizacji działa w przeglądarce — zostaw kartę otwartą,
 * aż wszystkie urządzenia się zaktualizują (zamknięcie karty przerywa
 * pozostałe w kolejce; trwająca aktualizacja na urządzeniu i tak się dokończy).
 */

const HOMEID_FLEET_CARD_VERSION = "1.1.0";

// Fazy zadania aktualizacji; FINAL = stany końcowe.
const HF_FINAL = ["done", "uptodate", "failed", "timeout", "offline", "cancelled"];

function hfEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// Porównanie wersji "3.0.2026.07.27.10.05" człon po członie, numerycznie.
function hfCmpVer(a, b) {
    const pa = String(a || "").split(/[.\-]/);
    const pb = String(b || "").split(/[.\-]/);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = parseInt(pa[i], 10) || 0;
        const y = parseInt(pb[i], 10) || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

// Uptime w sekundach -> "3d 4h" / "5h 12m" / "42m" / "18s".
function hfUptime(sec) {
    const s = parseInt(sec, 10);
    if (isNaN(s) || s < 0) return "";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
}

class HomeidFleetCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._devices = [];          // wiersze floty z rejestru HA
        this._selected = new Set();  // zaznaczone device_id
        this._jobs = new Map();      // device_id -> {phase, note, t0, startVersion}
        this._queue = [];            // device_id oczekujące
        this._active = null;         // device_id aktualnie aktualizowane
        this._batch = null;          // {done, total} bieżącej serii
        this._sort = { key: "model", dir: 1 };
        this._filter = "";
        this._searchFocus = false;
        this._regLoaded = false;
        this._subscribed = false;
        this._unsubs = [];
        this._reloadTimer = null;
        this._settleTimer = null;
        this._ticker = null;
        this._sig = "";

        // Delegacja zdarzeń — DOM jest przebudowywany przy każdym renderze.
        this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
        this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
        this.shadowRoot.addEventListener("input", (e) => {
            const t = e.target;
            if (t && t.dataset && t.dataset.search !== undefined) {
                this._filter = t.value;
                this._searchFocus = true;
                this._sig = "";
                this._render();
            }
        });
        // Zapamiętujemy fokus wyszukiwarki, żeby przywrócić go po re-renderze
        // (innerHTML wymienia całe drzewo, więc pole traciłoby kursor).
        this.shadowRoot.addEventListener("focusin", (e) => {
            const t = e.target;
            if (t && t.dataset && t.dataset.search !== undefined) this._searchFocus = true;
        });
        this.shadowRoot.addEventListener("focusout", (e) => {
            const t = e.target;
            if (t && t.dataset && t.dataset.search !== undefined) this._searchFocus = false;
        });
    }

    static getStubConfig() {
        return { title: "HomeID — flota" };
    }

    static getConfigElement() {
        return document.createElement("homeid-fleet-card-editor");
    }

    setConfig(config) {
        this._config = Object.assign({
            title: "HomeID — flota",
            manufacturer: "HomeID",
            timeout: 300,         // s na całą aktualizację jednego urządzenia
            settle: 5,            // s przerwy zanim ruszy następne
            stop_on_error: false, // przerwij kolejkę po failed/timeout
            show_diagnostics: true, // IP + RSSI pod nazwą
        }, config);
        this._sig = "";
        this._render();
    }

    getCardSize() {
        return 2 + this._devices.length;
    }

    set hass(hass) {
        this._hass = hass;
        if (!this._regLoaded) {
            this._regLoaded = true;
            this._reloadRegistries();
        }
        if (!this._subscribed && this.isConnected) this._subscribe();
        this._tick();
        this._render();
    }

    connectedCallback() {
        if (this._hass) this._subscribe();
    }

    disconnectedCallback() {
        for (const p of this._unsubs) {
            Promise.resolve(p).then((u) => { try { u(); } catch (e) { /* już zamknięte */ } });
        }
        this._unsubs = [];
        this._subscribed = false;
        this._stopTicker();
        if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    }

    // -- rejestr urządzeń / encji ------------------------------------------

    _subscribe() {
        if (this._subscribed || !this._hass) return;
        this._subscribed = true;
        const conn = this._hass.connection;
        // Po OTA firmware publikuje discovery z nową wersją -> rejestr się
        // zmienia -> odświeżamy listę (m.in. kolumnę wersji).
        for (const ev of ["device_registry_updated", "entity_registry_updated"]) {
            this._unsubs.push(conn.subscribeEvents(() => this._scheduleReload(), ev));
        }
    }

    _scheduleReload() {
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => {
            this._reloadTimer = null;
            this._reloadRegistries();
        }, 1500);
    }

    async _reloadRegistries() {
        if (!this._hass) return;
        try {
            const [devs, ents] = await Promise.all([
                this._hass.callWS({ type: "config/device_registry/list" }),
                this._hass.callWS({ type: "config/entity_registry/list" }),
            ]);
            const byDev = new Map();
            for (const e of ents) {
                if (e.disabled_by || !e.device_id) continue;
                if (!byDev.has(e.device_id)) byDev.set(e.device_id, []);
                byDev.get(e.device_id).push(e);
            }
            const mf = String(this._config.manufacturer || "HomeID").toLowerCase();
            const list = [];
            for (const d of devs) {
                if (String(d.manufacturer || "").toLowerCase() !== mf) continue;
                const de = byDev.get(d.id) || [];
                const row = {
                    id: d.id,
                    name: d.name_by_user || d.name || "?",
                    model: d.model || "?",
                    sw: d.sw_version || "",
                    chip: this._chipId(d),
                    btnUpdate: this._findEntity(de, "button", "update",
                        "Zainstaluj aktualizacje", ["zainstaluj_aktualizacje", "_update"]),
                    btnRestart: this._findEntity(de, "button", "restart",
                        "Restart", ["_restart"]),
                    otaSensor: this._findEntity(de, "sensor", null,
                        "Status aktualizacji", ["status_aktualizacji", "_ota"]),
                    ipSensor: this._findEntity(de, "sensor", null,
                        "IP address", ["ip_address", "_ip"]),
                    rssiSensor: this._findEntity(de, "sensor", "signal_strength",
                        "WiFi signal", ["wifi_signal", "_rssi"]),
                    uptimeSensor: this._findEntity(de, "sensor", "duration",
                        "Uptime", ["uptime"]),
                };
                if (row.btnUpdate) list.push(row); // tylko urządzenia z przyciskiem OTA
            }
            this._devices = list;
            this._sig = "";
            // Świeży rejestr = świeże wersje -> maszyna stanów może domknąć
            // aktywne zadanie po zmianie sw_version (patrz _tick).
            this._tick();
            this._render();
        } catch (err) {
            console.error("homeid-fleet-card: nie udało się wczytać rejestru", err);
        }
    }

    _chipId(d) {
        // MQTT discovery: identifiers = [["mqtt", "<chip_id>"]]
        for (const pair of d.identifiers || []) {
            const v = Array.isArray(pair) ? pair[pair.length - 1] : pair;
            if (v != null && String(v).length) return String(v);
        }
        return "";
    }

    // Encję rozpoznajemy po device_class ze stanu (odporne na zmianę nazwy),
    // z fallbackiem na original_name z rejestru i człon entity_id.
    _findEntity(ents, domain, devClass, origName, slugs) {
        const inDomain = ents.filter((e) => e.entity_id.startsWith(domain + "."));
        if (devClass && this._hass) {
            const hit = inDomain.find((e) => {
                const st = this._hass.states[e.entity_id];
                return st && st.attributes && st.attributes.device_class === devClass;
            });
            if (hit) return hit.entity_id;
        }
        if (origName) {
            const hit = inDomain.find((e) => (e.original_name || "") === origName);
            if (hit) return hit.entity_id;
        }
        for (const slug of slugs || []) {
            const hit = inDomain.find((e) => e.entity_id.includes(slug));
            if (hit) return hit.entity_id;
        }
        return null;
    }

    // -- stan urządzeń ------------------------------------------------------

    _isOnline(dev) {
        const st = this._hass && this._hass.states[dev.btnUpdate];
        return !!st && st.state !== "unavailable";
    }

    _otaState(dev) {
        if (!dev.otaSensor || !this._hass) return null;
        const st = this._hass.states[dev.otaSensor];
        return st ? st.state : null;
    }

    _diag(dev, entId) {
        const st = entId && this._hass ? this._hass.states[entId] : null;
        return st && st.state !== "unavailable" && st.state !== "unknown" ? st.state : "";
    }

    _uptimeSec(dev) {
        const v = parseInt(this._diag(dev, dev.uptimeSensor), 10);
        return isNaN(v) ? -1 : v;
    }

    // Najnowsza wersja w flocie per model — starsze podświetlamy.
    _maxVerByModel() {
        const max = {};
        for (const d of this._devices) {
            if (!d.sw) continue;
            if (!max[d.model] || hfCmpVer(d.sw, max[d.model]) > 0) max[d.model] = d.sw;
        }
        return max;
    }

    _isStale(dev, maxVer) {
        return !!(dev.sw && maxVer[dev.model] && hfCmpVer(dev.sw, maxVer[dev.model]) < 0);
    }

    // Urządzenia po filtrze wyszukiwarki i bieżącym sortowaniu.
    _visibleDevices(maxVer) {
        let list = this._devices;
        const f = this._filter.trim().toLowerCase();
        if (f) {
            list = list.filter((d) => [
                d.name, d.model, d.chip, d.sw, this._diag(d, d.ipSensor),
            ].join(" ").toLowerCase().includes(f));
        }
        const byName = (a, b) => a.name.localeCompare(b.name, "pl");
        const cmps = {
            name: byName,
            model: (a, b) => a.model.localeCompare(b.model, "pl") || byName(a, b),
            version: (a, b) => hfCmpVer(a.sw, b.sw) || byName(a, b),
            uptime: (a, b) => (this._uptimeSec(a) - this._uptimeSec(b)) || byName(a, b),
            status: (a, b) => (this._isOnline(b) - this._isOnline(a)) ||
                (this._isStale(b, maxVer) - this._isStale(a, maxVer)) || byName(a, b),
        };
        const cmp = cmps[this._sort.key] || cmps.model;
        const dir = this._sort.dir;
        return [...list].sort((a, b) => dir * cmp(a, b));
    }

    // -- kolejka aktualizacji ------------------------------------------------

    _enqueue(ids) {
        const idle = !this._active && !this._queue.length && !this._settleTimer;
        let added = 0;
        for (const id of ids) {
            if (this._active === id || this._queue.includes(id)) continue;
            this._jobs.set(id, { phase: "queued", t0: Date.now() });
            this._queue.push(id);
            added++;
        }
        if (!added) return;
        if (idle) this._batch = { done: 0, total: added };
        else if (this._batch) this._batch.total += added;
        if (!this._active && !this._settleTimer) this._startNext();
        this._sig = "";
        this._render();
    }

    _startNext() {
        this._settleTimer = null;
        const id = this._queue.shift();
        if (id === undefined) {
            this._stopTicker();
            this._sig = "";
            this._render();
            return;
        }
        const dev = this._devices.find((d) => d.id === id);
        if (!dev) { this._jobs.delete(id); return this._startNext(); }
        if (!this._isOnline(dev)) {
            this._jobs.set(id, { phase: "offline", t0: Date.now() });
            if (this._batch) this._batch.done++;
            return this._startNext();
        }
        const job = { phase: "pressing", t0: Date.now(), startVersion: dev.sw };
        this._jobs.set(id, job);
        this._active = id;
        this._startTicker();
        this._hass.callService("button", "press", { entity_id: dev.btnUpdate })
            .catch((err) => {
                if (this._active === id) this._finish(id, "failed", "błąd usługi: " + err.message);
            });
        this._sig = "";
        this._render();
    }

    _finish(id, phase, note) {
        const job = this._jobs.get(id);
        if (!job) return;
        if (phase) job.phase = phase;
        if (note !== undefined) job.note = note;
        if (this._active === id) this._active = null;
        if (this._batch) this._batch.done++;
        const bad = job.phase === "failed" || job.phase === "timeout";
        if (bad && this._config.stop_on_error) this._cancelQueue("przerwano po błędzie");
        if (this._queue.length) {
            // Chwila oddechu między urządzeniami (broker, WiFi, serwer OTA).
            this._settleTimer = setTimeout(() => this._startNext(),
                Math.max(0, this._config.settle || 0) * 1000);
        } else {
            this._stopTicker();
        }
        this._sig = "";
        this._render();
    }

    _cancelQueue(noteText) {
        for (const id of this._queue) {
            this._jobs.set(id, { phase: "cancelled", t0: Date.now(), note: noteText });
            if (this._batch) this._batch.total--;
        }
        this._queue = [];
        this._sig = "";
        this._render();
    }

    // Maszyna stanów aktywnego zadania; wołana przy każdej zmianie stanu HA,
    // co sekundę z tickera (upływ czasu / timeout) i po przeładowaniu rejestru.
    //
    // WAŻNE: frontend HA koalescuje zmiany stanów — przy szybkim OTA karta może
    // w ogóle nie zobaczyć przejścia offline->online ani stanu pośredniego.
    // Dlatego sukces rozpoznajemy po WARTOŚCIACH, nie po samych przejściach:
    //  - ota/state wraca do "idle" (wartość po reboocie z nowym firmware),
    //  - albo sw_version w rejestrze różni się od wersji sprzed aktualizacji.
    _tick() {
        const id = this._active;
        if (!id || !this._hass) return;
        const dev = this._devices.find((d) => d.id === id);
        const job = this._jobs.get(id);
        if (!dev || !job) { this._active = null; return; }

        if ((Date.now() - job.t0) / 1000 > (this._config.timeout || 300)) {
            return this._finish(id, "timeout");
        }
        const online = this._isOnline(dev);
        const st = this._otaState(dev);
        const swChanged = !!(dev.sw && job.startVersion && dev.sw !== job.startVersion);

        // Nowa wersja w rejestrze = aktualizacja się udała, niezależnie od fazy.
        if (swChanged) return this._finish(id, "done");

        switch (job.phase) {
            case "pressing":
                // Firmware publikuje "downloading" od razu po odebraniu komendy.
                if (st === "downloading") { job.phase = "downloading"; this._sig = ""; }
                else if (!online) { job.phase = "rebooting"; this._sig = ""; }
                break;
            case "downloading":
                // Blokujące pobieranie może zerwać sesję MQTT (LWT offline)
                // zarówno przy sukcesie (reboot), jak i przy 304/failed.
                if (!online) { job.phase = "rebooting"; this._sig = ""; }
                else if (st === "idle") this._finish(id, "done"); // reboot przegapiony
                else if (st === "up to date") this._finish(id, "uptodate");
                else if (st && (st.startsWith("failed") || st === "no wifi")) {
                    this._finish(id, "failed", st);
                }
                break;
            case "rebooting":
                // Po powrocie online czekamy na świeży ota/state (retained
                // "downloading" może jeszcze wisieć chwilę na brokerze).
                if (online && st && st !== "downloading" && st !== "unavailable") {
                    if (st.startsWith("failed") || st === "no wifi") this._finish(id, "failed", st);
                    else if (st === "up to date") this._finish(id, "uptodate");
                    else this._finish(id, "done"); // "idle" = boot z nowym firmware
                }
                break;
        }
    }

    _startTicker() {
        if (this._ticker) return;
        this._ticker = setInterval(() => {
            this._tick();
            this._sig = "";
            this._render();
        }, 1000);
    }

    _stopTicker() {
        if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    }

    // -- zdarzenia UI ---------------------------------------------------------

    _onClick(e) {
        const path = e.composedPath();
        const sortEl = path.find((n) => n.dataset && n.dataset.sort);
        if (sortEl) {
            const key = sortEl.dataset.sort;
            if (this._sort.key === key) this._sort.dir *= -1;
            else this._sort = { key, dir: 1 };
            this._sig = "";
            this._render();
            return;
        }
        const el = path.find((n) => n.dataset && n.dataset.act);
        if (!el) return;
        const act = el.dataset.act;
        const id = el.dataset.id;
        if (act === "update-one" && id) {
            this._enqueue([id]);
        } else if (act === "update-selected") {
            const ids = this._devices.filter((d) => this._selected.has(d.id)).map((d) => d.id);
            this._enqueue(ids);
        } else if (act === "cancel") {
            this._cancelQueue("anulowano");
        } else if (act === "restart-one" && id) {
            const dev = this._devices.find((d) => d.id === id);
            if (dev && dev.btnRestart &&
                confirm(`Zrestartować "${dev.name}"?`)) {
                this._hass.callService("button", "press", { entity_id: dev.btnRestart });
            }
        } else if (act === "clear-results") {
            for (const [jid, j] of this._jobs) {
                if (HF_FINAL.includes(j.phase)) this._jobs.delete(jid);
            }
            this._batch = null;
            this._sig = "";
            this._render();
        }
    }

    _onChange(e) {
        const t = e.target;
        if (!t || !t.dataset) return;
        if (t.dataset.selall !== undefined) {
            // Zaznaczenie zbiorcze działa na urządzeniach WIDOCZNYCH (po filtrze).
            const visible = this._visibleDevices(this._maxVerByModel());
            if (t.checked) {
                for (const d of visible) {
                    if (this._isOnline(d)) this._selected.add(d.id);
                }
            } else {
                for (const d of visible) this._selected.delete(d.id);
            }
        } else if (t.dataset.sel) {
            if (t.checked) this._selected.add(t.dataset.sel);
            else this._selected.delete(t.dataset.sel);
        } else {
            return;
        }
        this._sig = "";
        this._render();
    }

    // -- render ---------------------------------------------------------------

    _statusCell(dev, job, stale) {
        const el = job ? Math.round((Date.now() - job.t0) / 1000) : 0;
        const chip = (txt, cls, title) =>
            `<span class="chip ${cls}"${title ? ` title="${hfEsc(title)}"` : ""}>${txt}</span>`;
        if (job) {
            switch (job.phase) {
                case "queued":      return chip("w kolejce", "muted");
                case "pressing":    return chip(`wysyłanie polecenia… ${el}s`, "run");
                case "downloading": return chip(`pobieranie firmware… ${el}s`, "run");
                case "rebooting":   return chip(`restart urządzenia… ${el}s`, "run");
                case "done": {
                    const from = job.startVersion, to = dev.sw;
                    const txt = from && to && from !== to
                        ? `${hfEsc(from)} → ${hfEsc(to)}` : "zaktualizowano";
                    return chip("✓ " + txt, "ok");
                }
                case "uptodate":  return chip("✓ wersja aktualna", "ok");
                case "failed":    return chip("✗ " + hfEsc(job.note || "błąd"), "err");
                case "timeout":   return chip("✗ przekroczono czas", "err");
                case "offline":   return chip("pominięto (offline)", "muted");
                case "cancelled": return chip("anulowano", "muted");
            }
        }
        if (!this._isOnline(dev)) return chip("offline", "muted");
        const st = this._otaState(dev);
        if (st && st.startsWith("failed")) return chip("ostatnie OTA: " + hfEsc(st), "err");
        if (stale) return chip("starsza wersja", "warn",
            "starsza niż najnowsza wersja tego modelu w flocie");
        return "";
    }

    _render() {
        if (!this._config) return;
        const maxVer = this._maxVerByModel();
        const running = !!this._active || !!this._queue.length || !!this._settleTimer;
        const visible = this._visibleDevices(maxVer);

        // Sygnatura — pomijamy render, gdy nic widocznego się nie zmieniło
        // (hass aktualizuje się przy KAŻDEJ zmianie stanu w całym HA).
        const sig = JSON.stringify([
            this._config.title,
            running, this._active, this._queue,
            this._batch, this._sort, this._filter,
            [...this._selected],
            visible.map((d) => {
                const j = this._jobs.get(d.id);
                return [d.id, d.name, d.model, d.sw, this._isOnline(d), this._otaState(d),
                    this._diag(d, d.ipSensor), this._diag(d, d.rssiSensor),
                    this._uptimeSec(d),
                    j ? [j.phase, j.note, running ? Math.round((Date.now() - j.t0) / 1000) : 0] : null];
            }),
        ]);
        if (sig === this._sig) return;
        this._sig = sig;

        const nOnline = this._devices.filter((d) => this._isOnline(d)).length;
        const nStale = this._devices.filter((d) => this._isStale(d, maxVer)).length;
        const nSel = this._devices.filter((d) => this._selected.has(d.id)).length;
        const visOnline = visible.filter((d) => this._isOnline(d));
        const allSel = visOnline.length > 0 && visOnline.every((d) => this._selected.has(d.id));
        const hasResults = [...this._jobs.values()].some((j) => HF_FINAL.includes(j.phase));

        const arrow = (key) => this._sort.key === key
            ? `<span class="arr">${this._sort.dir > 0 ? "▲" : "▼"}</span>`
            : `<span class="arr dim">↕</span>`;

        const rows = visible.map((d) => {
            const online = this._isOnline(d);
            const job = this._jobs.get(d.id);
            const busy = job && !HF_FINAL.includes(job.phase);
            const stale = this._isStale(d, maxVer);
            const ip = this._config.show_diagnostics ? this._diag(d, d.ipSensor) : "";
            const rssi = this._config.show_diagnostics ? this._diag(d, d.rssiSensor) : "";
            const up = this._uptimeSec(d);
            const sub = [d.chip ? "ID " + hfEsc(d.chip) : "", ip ? hfEsc(ip) : "",
                rssi ? hfEsc(rssi) + " dBm" : ""].filter(Boolean).join(" · ");
            return `
            <tr class="${online ? "" : "offline"}">
                <td class="c-sel">
                    <input type="checkbox" data-sel="${d.id}"
                        ${this._selected.has(d.id) ? "checked" : ""}
                        ${online && !busy ? "" : "disabled"}>
                </td>
                <td class="c-name">
                    <span class="dot ${online ? "on" : "off"}"
                        title="${online ? "online" : "offline"}"></span>
                    <div class="who">
                        <div class="name">${hfEsc(d.name)}</div>
                        ${sub ? `<div class="sub">${sub}</div>` : ""}
                    </div>
                </td>
                <td class="c-model">${hfEsc(d.model)}</td>
                <td class="c-ver ${stale ? "stale" : ""}">${hfEsc(d.sw || "—")}</td>
                <td class="c-up">${online && up >= 0 ? hfUptime(up) : "—"}</td>
                <td class="c-stat">${this._statusCell(d, job, stale)}</td>
                <td class="c-acts">
                    <button class="btn small" data-act="update-one" data-id="${d.id}"
                        ${online && !busy ? "" : "disabled"}>Aktualizuj</button>
                    ${d.btnRestart ? `
                    <button class="btn small ghost" data-act="restart-one" data-id="${d.id}"
                        title="Restart urządzenia" ${online && !busy ? "" : "disabled"}>⟳</button>` : ""}
                </td>
            </tr>`;
        }).join("");

        const activeDev = this._active
            ? this._devices.find((d) => d.id === this._active) : null;
        const progress = running && this._batch
            ? `Aktualizacja ${Math.min(this._batch.done + 1, this._batch.total)}/${this._batch.total}` +
              (activeDev ? ` — ${hfEsc(activeDev.name)}` : "…")
            : "";

        this.shadowRoot.innerHTML = `
        <style>
            :host { display: block; }
            ha-card { padding: 12px 16px 16px; }
            .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                    margin-bottom: 4px; }
            .title { font-size: 1.15em; font-weight: 500; margin-right: auto;
                     color: var(--primary-text-color); }
            .search { padding: 7px 10px; border: 1px solid var(--divider-color);
                      border-radius: 6px; background: var(--card-background-color);
                      color: var(--primary-text-color); font: inherit;
                      font-size: 0.85em; width: 170px; }
            .search:focus { outline: none; border-color: var(--primary-color); }
            .summary { color: var(--secondary-text-color); font-size: 0.85em;
                       width: 100%; margin-bottom: 8px; }
            .progress { color: var(--primary-color); font-size: 0.9em; width: 100%;
                        margin: 2px 0 8px; font-weight: 500; }
            .btn { border: none; border-radius: 6px; padding: 7px 14px; cursor: pointer;
                   background: var(--primary-color); color: var(--text-primary-color, #fff);
                   font: inherit; font-size: 0.85em; }
            .btn:disabled { opacity: 0.35; cursor: default; }
            .btn.small { padding: 5px 10px; }
            .btn.ghost { background: transparent; color: var(--primary-color);
                         border: 1px solid var(--primary-color); }
            .btn.danger { background: var(--error-color, #db4437); }
            .twrap { overflow-x: auto; }
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; font-size: 0.75em; font-weight: 500;
                 color: var(--secondary-text-color); padding: 6px 10px 6px 0;
                 border-bottom: 1px solid var(--divider-color); white-space: nowrap; }
            th.sortable { cursor: pointer; user-select: none; }
            th.sortable:hover { color: var(--primary-text-color); }
            .arr { font-size: 0.9em; }
            .arr.dim { opacity: 0.35; }
            td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--divider-color);
                 vertical-align: middle; }
            tr.offline .c-name, tr.offline .c-model, tr.offline .c-ver,
            tr.offline .c-up { opacity: 0.5; }
            .c-sel { width: 26px; }
            .c-name { min-width: 150px; }
            .c-name .dot { display: inline-block; vertical-align: middle;
                           margin-right: 8px; }
            .c-name .who { display: inline-block; vertical-align: middle;
                           max-width: 260px; }
            .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
            .dot.on  { background: var(--success-color, #43a047); }
            .dot.off { background: var(--disabled-text-color, #9e9e9e); }
            .name { color: var(--primary-text-color); white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis; }
            .sub { color: var(--secondary-text-color); font-size: 0.78em;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .c-model { font-size: 0.85em; color: var(--primary-text-color);
                       white-space: nowrap; }
            .c-ver { font-family: monospace; font-size: 0.82em; white-space: nowrap;
                     color: var(--primary-text-color); }
            .c-ver.stale { color: var(--warning-color, #ff9800); font-weight: 600; }
            .c-up { font-size: 0.82em; white-space: nowrap;
                    color: var(--primary-text-color); }
            .c-stat { font-size: 0.82em; min-width: 120px; }
            .chip { padding: 2px 8px; border-radius: 10px; white-space: nowrap;
                    background: var(--secondary-background-color); }
            .chip.ok   { color: var(--success-color, #43a047); font-weight: 600; }
            .chip.err  { color: var(--error-color, #db4437); font-weight: 600; }
            .chip.warn { color: var(--warning-color, #ff9800); }
            .chip.run  { color: var(--primary-color); font-weight: 600; }
            .chip.muted{ color: var(--secondary-text-color); }
            .c-acts { white-space: nowrap; text-align: right; width: 1%; }
            .c-acts .btn + .btn { margin-left: 6px; }
            .empty { color: var(--secondary-text-color); padding: 16px 0; }
            input[type=checkbox] { accent-color: var(--primary-color); }
        </style>
        <ha-card>
            <div class="head">
                <span class="title">${hfEsc(this._config.title)}</span>
                <input class="search" type="search" data-search placeholder="Szukaj…"
                    value="${hfEsc(this._filter)}">
                ${running
                    ? `<button class="btn danger" data-act="cancel"
                           ${this._queue.length ? "" : "disabled"}>Anuluj pozostałe</button>`
                    : `<button class="btn" data-act="update-selected"
                           ${nSel ? "" : "disabled"}>Aktualizuj zaznaczone (${nSel})</button>`}
                ${hasResults && !running
                    ? `<button class="btn ghost" data-act="clear-results">Wyczyść wyniki</button>` : ""}
            </div>
            ${progress ? `<div class="progress">${progress}</div>` : ""}
            <div class="summary">
                ${this._devices.length} urządzeń · ${nOnline} online
                ${nStale ? ` · <span style="color:var(--warning-color,#ff9800)">${nStale} ze starszą wersją</span>` : ""}
                ${this._filter.trim() ? ` · filtr: ${visible.length}/${this._devices.length}` : ""}
            </div>
            ${this._devices.length ? `
            <div class="twrap">
            <table>
                <thead>
                    <tr>
                        <th class="c-sel">
                            <input type="checkbox" data-selall
                                title="zaznacz widoczne online"
                                ${allSel ? "checked" : ""}
                                ${visOnline.length && !running ? "" : "disabled"}>
                        </th>
                        <th class="sortable" data-sort="name">Nazwa ${arrow("name")}</th>
                        <th class="sortable" data-sort="model">Model ${arrow("model")}</th>
                        <th class="sortable" data-sort="version">Wersja ${arrow("version")}</th>
                        <th class="sortable" data-sort="uptime">Uptime ${arrow("uptime")}</th>
                        <th class="sortable" data-sort="status">Status ${arrow("status")}</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${rows || `<tr><td colspan="7" class="empty">
                        Brak urządzeń pasujących do "${hfEsc(this._filter)}".</td></tr>`}
                </tbody>
            </table>
            </div>` : `
            <div class="empty">
                Nie znaleziono urządzeń (manufacturer: "${hfEsc(this._config.manufacturer)}").
                Sprawdź, czy urządzenia są sparowane przez MQTT discovery.
            </div>`}
        </ha-card>`;

        // "zaznacz widoczne" jako indeterminate przy częściowym zaznaczeniu
        const selall = this.shadowRoot.querySelector("[data-selall]");
        if (selall) {
            const nVisSel = visOnline.filter((d) => this._selected.has(d.id)).length;
            selall.indeterminate = nVisSel > 0 && !allSel;
        }
        // Przywróć fokus wyszukiwarki po przebudowie DOM (kursor na końcu).
        if (this._searchFocus) {
            const s = this.shadowRoot.querySelector("[data-search]");
            if (s) {
                s.focus();
                const n = s.value.length;
                try { s.setSelectionRange(n, n); } catch (e) { /* nieobsługiwane */ }
            }
        }
    }
}

// -- prosty edytor konfiguracji (UI dashboardu) ------------------------------

class HomeidFleetCardEditor extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
    }

    set hass(h) { this._hass = h; }

    setConfig(config) {
        this._config = Object.assign({
            title: "HomeID — flota",
            manufacturer: "HomeID",
            timeout: 300,
            settle: 5,
            stop_on_error: false,
            show_diagnostics: true,
        }, config);
        this._render();
    }

    _emit() {
        this.dispatchEvent(new CustomEvent("config-changed", {
            detail: { config: this._config }, bubbles: true, composed: true,
        }));
    }

    _render() {
        const c = this._config;
        this.shadowRoot.innerHTML = `
        <style>
            .f { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
            label { font-size: 0.85em; color: var(--secondary-text-color); }
            input[type=text], input[type=number] {
                padding: 8px; border: 1px solid var(--divider-color); border-radius: 4px;
                background: var(--card-background-color); color: var(--primary-text-color);
                font: inherit; }
            .chk { flex-direction: row; align-items: center; gap: 8px; }
            .chk label { color: var(--primary-text-color); }
        </style>
        <div class="f"><label>Tytuł</label>
            <input type="text" id="title" value="${hfEsc(c.title)}"></div>
        <div class="f"><label>Manufacturer (filtr rejestru urządzeń)</label>
            <input type="text" id="manufacturer" value="${hfEsc(c.manufacturer)}"></div>
        <div class="f"><label>Limit czasu na urządzenie [s]</label>
            <input type="number" id="timeout" min="30" value="${c.timeout}"></div>
        <div class="f"><label>Przerwa między urządzeniami [s]</label>
            <input type="number" id="settle" min="0" value="${c.settle}"></div>
        <div class="f chk">
            <input type="checkbox" id="stop_on_error" ${c.stop_on_error ? "checked" : ""}>
            <label for="stop_on_error">Przerwij kolejkę po błędzie</label></div>
        <div class="f chk">
            <input type="checkbox" id="show_diagnostics" ${c.show_diagnostics ? "checked" : ""}>
            <label for="show_diagnostics">Pokazuj IP i RSSI</label></div>`;

        for (const id of ["title", "manufacturer"]) {
            this.shadowRoot.getElementById(id).addEventListener("change", (e) => {
                this._config = { ...this._config, [id]: e.target.value };
                this._emit();
            });
        }
        for (const id of ["timeout", "settle"]) {
            this.shadowRoot.getElementById(id).addEventListener("change", (e) => {
                this._config = { ...this._config, [id]: parseInt(e.target.value, 10) || 0 };
                this._emit();
            });
        }
        for (const id of ["stop_on_error", "show_diagnostics"]) {
            this.shadowRoot.getElementById(id).addEventListener("change", (e) => {
                this._config = { ...this._config, [id]: e.target.checked };
                this._emit();
            });
        }
    }
}

customElements.define("homeid-fleet-card-editor", HomeidFleetCardEditor);
customElements.define("homeid-fleet-card", HomeidFleetCard);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "homeid-fleet-card",
    name: "HomeID Fleet Card",
    description: "Lista urządzeń HomeID z wersjami firmware i sekwencyjną aktualizacją OTA.",
    preview: false,
});

console.info(`%c HOMEID-FLEET-CARD %c v${HOMEID_FLEET_CARD_VERSION} `,
    "background:#03a9f4;color:#fff;padding:2px 4px;border-radius:3px 0 0 3px;",
    "background:#555;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0;");
