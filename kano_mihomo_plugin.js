//<script>
// ============================================================
// mihomo Core Plugin (Enhanced) v1.5.1
// Copyright (c) 2026 Jace (By_Jace) — MIT License
//
// Copyright & acknowledgments (derivative work, respecting upstream licenses):
//   · kanoqwq "Cat Clash (Mihomo) plugin 2.4" — MIT: TUN+FORWARD architecture and config template derived from it
//     https://github.com/kanoqwq/UFI-TOOLS-PLUGINS
//   · MetaCubeX/mihomo — MIT: downloads and runs the official android-arm64 core build
//   · Zephyruso/zashboard — MIT: embedded dashboard
//
// Features: official core install/upgrade (station-first + mirrors + sha256) / local node file import
//       / subscription manager / config reset / boot autostart / embedded ZashBoard auto-connect / auto refresh
//       / update check on load (station version.json: silent when clean, dialog when update available)
// Security: random admin secret at install / CORS fully disabled / tightened permissions / node credentials never leave the device
// Config shape: local-nodes-only mode (select/urltest groups + CN direct split routing)
// ============================================================
(() => {
    const PLUGIN_VER = "1.5.1"
    const CORE_TAG = "v1.19.31"
    const DIR = "/data/kano_mihomo"
    const SERVICE = `${DIR}/Scripts/Clash.Service`
    const CONF = `${DIR}/Proxy/config.yaml`
    const LOG = "/sdcard/mihomo内核日志.txt"
    const CTRL_PORT = 7788
    // Core upgrade: download prefixes tried in order (empty = direct GitHub)
    const GH_MIRRORS = ["", "https://gh-proxy.com/", "https://ghfast.top/"]
    const CORE_URL_PATH = `https://github.com/MetaCubeX/mihomo/releases/download/${CORE_TAG}/mihomo-android-arm64-v8-${CORE_TAG}.gz`
    // Local package lookup order (online download as fallback for remote installs)
    const ZIP_CANDIDATES = ["/sdcard/kano_mihomo.zip", "/sdcard/Download/kano_mihomo.zip", "/sdcard/下载/kano_mihomo.zip", "/data/data/com.minikano.f50_sms/files/uploads/kano_mihomo.zip"]
    // Online sources + sha256 verification (anti-truncation / anti-tamper)
    // ⚠️ Order matters: constants must be declared before use (TDZ breaks the whole plugin)
    const GITHUB_REPO = "xyjace/kano_mihomo"
    const RELEASE_TAG = "v1.5.1"
    const RELEASE_BASE = `https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}/`
    const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/` // fallback source
    // Station mirror first (fast CN direct; GitHub as backup)
    const STATION_BASE = "https://www.paboe.top:48444/fe3659d9e17298bcfa2c18d0bd9478f1/18608c68/lyobbztc/kano_mihomo(增强版)/"
    const ZIP_URLS = [STATION_BASE + "kano_mihomo.zip", RELEASE_BASE + "kano_mihomo.zip"]
    const MINI_URLS = [STATION_BASE + "kano_mihomo_mini.zip", RELEASE_BASE + "kano_mihomo_mini.zip"]
    const CONFIG_URLS = [STATION_BASE + "config-lite.yaml", RELEASE_BASE + "config-lite.yaml"]
    // Update manifest: all updatable resource versions live in station version.json (fetched on load)
    const VERSION_URLS = [STATION_BASE + "version.json", RAW_BASE + "package/version.json"]
    const ZIP_FULL_SHA = "c3e80a7cc2a3fa7d48d51823e8c5f466c692a09cfb0330d7628d6e56a85ca62f"
    const ZIP_MINI_SHA = "5f500c11d557b1dfb616834f9b82195bb27475941b3d28f3ba9f719a78c4b1aa"
    const CORE_GZ_SHA = "de00bc53ed151636ca078c812a82a5315687d8d52164db230f1935b2a37904f6"
    const CONFIG_URL = RAW_BASE + "package/Proxy/config.template.yaml"
    // Geo databases: station direct links (same source as config geox-url); GitHub removed from the path
    const GEOIP_URLS = [STATION_BASE + "geoip.metadb", RAW_BASE + "package/Proxy/geoip.metadb"]
    const GEOSITE_URLS = [STATION_BASE + "geosite.dat", RAW_BASE + "package/Proxy/geosite.dat"]
    const GEOIP_SHA = "0a0af840d4b77225cd53abf63d68c71946127bef426fdf5d92ad64b741f8f1ce"
    const GEOSITE_SHA = "12dfa24f466986cfe1ead0c67e554e5c67642bb6b204ea64172178d25825f216"
    // Fingerprints of resources shipped with this plugin (cross-checked against station version.json)
    const CHECK = { geoip: GEOIP_SHA, geosite: GEOSITE_SHA, configVer: "1.5.0" }

    // Download + sha256 verify (-k tolerates old CA stores; on failure echoes curl exit and file size)
    const dlVerify = async (url, out, sha, timeoutMs) => {
        const res = await runShellWithRoot(`
CURL=/data/data/com.minikano.f50_sms/files/curl
$CURL -kfL --retry 2 -m ${Math.floor(timeoutMs / 1000)} -o ${out} "${url}"
echo "curl_exit=$?"
[ -f ${out} ] && ls -s ${out} || echo "no_file"
H=$(sha256sum ${out} 2>/dev/null | awk '{print $1}')
[ "$H" = "${sha}" ] && echo "SHA_OK" || echo "SHA_BAD:$H"
    `, timeoutMs + 30000)
        const c = (res.content || '').trim()
        return { ok: res.success && c.includes('SHA_OK'), content: c }
    }

    // Multi-source x mirror download loop (github urls get mirror prefixes, others direct)
    const dlVerifyAny = async (urls, out, sha, timeoutMs) => {
        let last = ''
        for (const u of urls) {
            const candidates = u.includes('github.com') ? GH_MIRRORS.map(m => m ? m + u : u) : [u]
            for (const full of candidates) {
                const r = await dlVerify(full, out, sha, timeoutMs)
                if (r.ok) return r
                last = r.content
            }
        }
        return { ok: false, content: last }
    }

    const checkAdvanceFunc = async () => {
        const res = await runShellWithRoot('whoami')
        if (res.content) {
            if (res.content.includes('root')) return true
        }
        return false
    }

    const checkWeak = async () => {
        try { if (typeof checkWeakToken === 'function' && await checkWeakToken()) {
            createToast(`检测到UFI-TOOLS使用了弱口令，为了你的安全，必须更改为复杂口令后再进行操作！！！`, "red", 8000)
            return true
        } } catch (e) { }
        return false
    }

    const isInstalled = async () => {
        const res = await runShellWithRoot(`ls ${SERVICE}`)
        return !!(res.success && res.content && res.content.includes('Clash.Service'))
    }

    // Cat-plugin conflict check: both use TUN device Meta, they cannot coexist
    const checkCatConflict = async () => {
        const res = await runShellWithRoot(`ls /data/clash/Scripts/Clash.Service`)
        if (res.success && res.content && res.content.includes('Clash.Service')) {
            createToast(`检测到猫猫Clash插件已安装（两者都用TUN设备Meta，不能并存）！请先卸载猫猫插件再使用本插件。`, 'red', 10000)
            return true
        }
        return false
    }

    const isRunning = async () => {
        const res = await runShellWithRoot(`${SERVICE} status`)
        return res.content && res.content.trim().startsWith('running')
    }

    const checkIsBootUp = async () => {
        const res = await runShellWithRoot(`
        grep -q '${SERVICE} start' /sdcard/ufi_tools_boot.sh
        echo $?
        `)
        return res.content.trim() == '0'
    }

    const showSecret = async () => {
        const res = await runShellWithRoot(`timeout 2s awk '/^secret/ {print $2}' ${CONF}`)
        return (res.content || '').trim().replace(/"/g, '')
    }

    // Live core version via -v (info panel shows the probed value, not a constant)
    const liveCoreVer = async () => {
        const res = await runShellWithRoot(`timeout 5s ${DIR}/Proxy/Clash.Core -v 2>/dev/null | head -1`)
        const m = (res.content || '').match(/v[\d.]+/)
        return m ? m[0] : ''
    }

    // ---------- Config normalization (v1.5.0) ----------
    // Any config (upload/import/reset) gets plugin-required fields auto-filled before activation,
    // so user-supplied configs no longer hit "access denied" dashboards or geo download failures.
    const sha256File = async (path) => {
        const r = await runShellWithRoot(`sha256sum ${path} 2>/dev/null | awk '{print $1}'`)
        return (r.content || '').trim()
    }
    const hasGeoFiles = async () => {
        const r = await runShellWithRoot(`[ -s ${DIR}/Proxy/geoip.metadb ] && [ -s ${DIR}/Proxy/geosite.dat ] && echo Y || echo N`)
        return (r.content || '').trim() === 'Y'
    }
    // Download geo databases into place (station first; skipped when present and sha matches)
    const ensureGeoFiles = async () => {
        if (await hasGeoFiles()) {
            createToast("geo 库已在位，跳过下载", '', 3000)
            return true
        }
        createToast("下载 geo 库（geoip 约8.5MB + geosite 约4.2MB）...", '', 8000)
        const rIp = await dlVerifyAny(GEOIP_URLS, `${DIR}/Proxy/geoip.metadb`, CHECK.geoip, 300 * 1000)
        const rSite = await dlVerifyAny(GEOSITE_URLS, `${DIR}/Proxy/geosite.dat`, CHECK.geosite, 300 * 1000)
        if (rIp.ok && rSite.ok) {
            await runShellWithRoot(`chmod 644 ${DIR}/Proxy/geoip.metadb ${DIR}/Proxy/geosite.dat`)
            return true
        }
        createToast("geo 库下载不完整，配置中 GEOIP/GEOSITE 规则启动会失败（纯 RULE-SET 配置不受影响）", 'pink', 10000)
        return !!(rIp.ok || rSite.ok)
    }
    const normalizeConfig = async (keepSecret) => {
        const s = keepSecret || await showSecret()
        const lines = []
        // Control-plane trio: fill in whatever line is missing (secret keeps its current value)
        lines.push(`grep -q '^external-controller:' ${CONF} || sed -i '1i external-controller: 0.0.0.0:${CTRL_PORT}' ${CONF}`)
        lines.push(`grep -q '^external-ui:' ${CONF} || sed -i '/^external-controller:/a external-ui: WebUI/zashboard' ${CONF}`)
        if (s && !/CHANGE_ME/.test(s)) {
            lines.push(`grep -q '^secret:' ${CONF} && sed -i 's/^secret: ".*"/secret: "${s}"/' ${CONF} || sed -i '/^external-ui:/a secret: "${s}"' ${CONF}`)
        }
        // Point geox-url at the station (core-initiated downloads use it too; GitHub out of the loop)
        lines.push(`grep -q '^geox-url:' ${CONF} || sed -i '/^secret:/a\\geox-url:\\n  geoip: "${STATION_BASE}geoip.metadb"\\n  geosite: "${STATION_BASE}geosite.dat"\\n  mmdb: "${STATION_BASE}geoip.metadb"' ${CONF}`)
        const r = await runShellWithRoot(lines.join('\n') + `\n`)
        return r.success
    }

    // ---------- Update check (v1.5.0): fetch station version.json on load; silent if clean ----------
    const fetchVersionManifest = async () => {
        for (const u of VERSION_URLS) {
            try {
                const r = await fetch(u, { cache: 'no-store' })
                if (r.ok) return await r.json()
            } catch (e) { }
        }
        return null
    }
    const cmpVer = (a, b) => {
        const p = (s) => String(s || '').replace(/^v/, '').split('.').map(Number)
        const [x, y] = [p(a), p(b)]
        for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
        return 0
    }
    const checkUpdates = async () => {
        const mf = await fetchVersionManifest()
        if (!mf || typeof mf !== 'object') return // manifest unreachable = stay silent (weak network is normal)
        const items = []
        let pluginItem = null
        if (mf.plugin && cmpVer(mf.plugin.version, PLUGIN_VER) > 0) {
            pluginItem = { name: '插件本体', cur: PLUGIN_VER, latest: mf.plugin.version, hint: mf.plugin.note || '功能更新' }
            items.push(pluginItem)
        }
        if (mf.core && await isInstalled()) {
            const live = await liveCoreVer()
            if (live && mf.core.version && cmpVer(mf.core.version, live) > 0) {
                items.push({ name: '内核', cur: live, latest: mf.core.version, hint: '点「升级内核」在线升级' })
            }
        }
        if (mf.geoip && mf.geosite && await isInstalled() && !(await hasGeoFiles())) {
            items.push({ name: 'geo 库', cur: '缺失', latest: mf.geoip.version || '内置', hint: '点「重置配置」自动补齐' })
        }
        if (mf.config && mf.config.version && mf.config.version !== CHECK.configVer && await isInstalled()) {
            // Newer config template: notify only, never forced (user config may be locally modified)
            items.push({ name: '配置模板', cur: CHECK.configVer || '未知', latest: mf.config.version, hint: '点「重置配置」拉取最新' })
        }
        if (!items.length) return
        if (typeof createModal !== 'function') {
            return createToast(`检测到更新：${items.map(i => `${i.name} ${i.cur}→${i.latest}`).join('；')}`, 'pink', 12000)
        }
        const { id, el } = createModal({
            name: "km_update_modal", title: "发现可用更新", maxWidth: "85%",
            showConfirm: false, onClose: () => true,
            content: `
        <div style="font-size:.75rem;line-height:1.9">
        ${items.map(i => `<div>▸ <b>${i.name}</b>：${i.cur} → <b>${i.latest}</b><br><span style="opacity:.7">${i.hint}</span></div>`).join('')}
        <div id="km_selfupd_box" style="${pluginItem ? '' : 'display:none'};margin-top:10px">
            <button id="km_selfupd_btn" class="btn" style="width:100%">一键升级插件到 ${pluginItem ? pluginItem.latest : ''}</button>
            <div id="km_selfupd_tip" style="opacity:.7;margin-top:6px">下载新版并自动替换本插件，失败自动回滚；升级过程请勿离开页面</div>
        </div>
        </div>`
        })
        showModal(id)
        const selfBtn = el.querySelector('#km_selfupd_btn')
        if (selfBtn && pluginItem) selfBtn.onclick = () => selfUpgrade(pluginItem, mf.plugin.js_sha256 || '')
    }

    // ---------- Self-upgrade (v1.5.0): download -> verify -> backup -> rewrite host store -> reload; rollback on failure ----------
    const JS_STORE = '/data/data/com.minikano.f50_sms/shared_prefs/kano_plugin_store.xml'
    const basicJsSanity = (text) => {
        // Lightweight sanity: non-empty, has plugin markers, braces/backticks balanced
        if (!text || text.length < 5000) return false
        if (!text.includes('PLUGIN_VER') || !text.includes('kano_mihomo')) return false
        const count = (ch) => (text.match(new RegExp('\\' + ch, 'g')) || []).length
        if (count('{') !== count('}') || count('(') !== count(')') || count('`') % 2 !== 0) return false
        return true
    }
    const selfUpgrade = async (item, expectSha) => {
        if (await checkWeak()) return
        const btn = document.querySelector('#km_selfupd_btn')
        const tip = document.querySelector('#km_selfupd_tip')
        if (btn) { btn.disabled = true; btn.textContent = `下载新版 ${item.latest} 中...` }
        // 1) fetch new JS (station first, GitHub fallback via mirrors)
        const JS_URLS = [STATION_BASE + "kano_mihomo_plugin.js", RAW_BASE + "kano_mihomo_plugin.js"]
        let jsText = '', lastErr = ''
        for (const u of JS_URLS) {
            const candidates = u.includes('github.com') ? GH_MIRRORS.map(m => m ? m + u : u) : [u]
            for (const full of candidates) {
                try {
                    const r = await fetch(full, { cache: 'no-store' })
                    if (r.ok) { jsText = await r.text(); break }
                } catch (e) { lastErr = String(e) }
            }
            if (jsText) break
        }
        // 2) sanity check (+ optional sha256 against manifest)
        if (!basicJsSanity(jsText)) {
            if (btn) { btn.disabled = false; btn.textContent = '一键升级（重试）' }
            return createToast(`新插件下载/校验失败：${lastErr || '内容异常'}，已取消`, 'red', 10000)
        }
        if (expectSha) {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsText))
            const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
            if (hex !== expectSha) {
                if (btn) { btn.disabled = false; btn.textContent = '一键升级（重试）' }
                return createToast('新插件 sha256 与清单不符，已取消（站点文件与清单不同步？）', 'red', 10000)
            }
        }
        if (tip) tip.textContent = '校验通过，写入中（失败将自动回滚）...'
        // 3) write new JS into root area (fetched in-browser, written via root shell)
        const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const newJsEsc = xmlEscape(jsText)
        const w = await runShellWithRoot(`
        cp ${CONF} ${DIR}/config.pre-selfupd.bak.yaml 2>/dev/null
        mkdir -p ${DIR}
        cat > ${DIR}/plugin.new.js <<'KMEOF'
${jsText}
KMEOF
        grep -q "PLUGIN_VER" ${DIR}/plugin.new.js && echo "DL_OK" || echo "DL_BAD"
    `, 60 * 1000)
        if (!(w.content || '').includes('DL_OK')) {
            if (btn) { btn.disabled = false; btn.textContent = '一键升级（重试）' }
            return createToast('新版落盘校验失败，已取消', 'red', 10000)
        }
        // 4) rewrite host store: keep backup; rebuild the single-key XML in place
        // Store shape: plain single key (concatenated plugin JS); keep head/tail, replace this plugin's block
        const w3 = await runShellWithRoot(`
        cp ${JS_STORE} ${JS_STORE}.pre-selfupd 2>/dev/null
        HEAD=\${HEAD:-} ; TAIL=\${TAIL:-}
        # 提取 <string name="kano_plugins"> 之前与 </string> 之后
        awk 'BEGIN{p=1} /<string name="kano_plugins">/{p=0} p{print}' ${JS_STORE} > ${DIR}/store.head
        awk '/<\\/string>/{f=1;next} f{print}' ${JS_STORE} > ${DIR}/store.tail
        { cat ${DIR}/store.head; printf '<string name="kano_plugins">'; cat ${DIR}/plugin.new.js; printf '</string>'; cat ${DIR}/store.tail; } > ${DIR}/store.new
        grep -q "PLUGIN_VER" ${DIR}/store.new && echo "STORE_OK" || echo "STORE_BAD"
    `, 30 * 1000)
        if (!(w3.content || '').includes('STORE_OK')) {
            await runShellWithRoot(`[ -f ${JS_STORE}.pre-selfupd ] && cp ${JS_STORE}.pre-selfupd ${JS_STORE}`)
            if (btn) { btn.disabled = false; btn.textContent = '一键升级（重试）' }
            return createToast('存储改写未通过校验，已回滚原插件', 'red', 10000)
        }
        // 5) atomic swap + cleanup + reload (host re-reads the store)
        await runShellWithRoot(`
        cp ${DIR}/store.new ${JS_STORE}
        chown \$(stat -c '%u:%g' ${JS_STORE}.pre-selfupd) ${JS_STORE} 2>/dev/null
        chmod \$(stat -c '%a' ${JS_STORE}.pre-selfupd) ${JS_STORE} 2>/dev/null
        mv ${DIR}/plugin.new.js ${DIR}/plugin.self.bak.js
        rm -f ${DIR}/store.head ${DIR}/store.tail ${DIR}/store.new ${JS_STORE}.pre-selfupd
        sync
    `, 30 * 1000)
        createToast(`插件已升级到 ${item.latest}，2 秒后自动刷新页面…`, 'green', 6000)
        setTimeout(() => location.reload(), 2000)
    }

    // ---------- Install ----------
    const installBtn = document.createElement('button')
    installBtn.textContent = `安装mihomo`
    installBtn.onclick = async () => {
        if (disabled_btn) return
        disabled_btn = true
        try {
            if (await checkWeak()) return
            if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
            if (await checkCatConflict()) return

            createToast("查找本地安装包 kano_mihomo.zip ...")
            let zipPath = null
            for (const p of ZIP_CANDIDATES) {
                const r = await runShellWithRoot(`ls ${p}`)
                if (r.success && r.content && r.content.includes('kano_mihomo.zip')) { zipPath = p; break }
            }
            let splitMode = false
            let lastErr = ''
            if (!zipPath) {
                createToast("本地无包，在线下载整包(约31MB，走设备网络)...", 'pink', 8000)
                const rFull = await dlVerifyAny(ZIP_URLS, "/data/kano_mihomo.zip", ZIP_FULL_SHA, 600 * 1000)
                if (rFull.ok) { zipPath = "/data/kano_mihomo.zip" } else { lastErr = rFull.content }
            }
            if (!zipPath) {
                // Split fallback: mini package (small, weak-network friendly) + core via CN mirrors
                createToast("整包失败，改走分体安装：迷你包+内核镜像...", 'pink', 8000)
                const r1 = await dlVerifyAny(MINI_URLS, "/data/kano_mihomo_mini.zip", ZIP_MINI_SHA, 120 * 1000)
                if (!r1.ok) {
                    return createToast(`在线下载失败(迷你包)：${String(lastErr || r1.content).replace(/\s+/g, ' ').slice(-160)}`, 'red', 15000)
                }
                let coreOK = false
                for (const m of GH_MIRRORS) {
                    const u = m ? (m + CORE_URL_PATH) : CORE_URL_PATH
                    createToast(`拉取内核：${m ? m.split('//')[1].split('/')[0] : 'github直连'} ...`, '', 5000)
                    const r2 = await dlVerify(u, "/data/kano_mihomo_core.gz", CORE_GZ_SHA, 600 * 1000)
                    if (r2.ok) { coreOK = true; break }
                    lastErr = r2.content
                }
                if (!coreOK) {
                    return createToast(`在线下载失败(内核镜像)：${String(lastErr).replace(/\s+/g, ' ').slice(-160)}`, 'red', 15000)
                }
                zipPath = "/data/kano_mihomo_mini.zip"
                splitMode = true
            }

            createToast("备份现有配置(如有)...")
            await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml 2>/dev/null`)

            createToast("解压安装包...")
            const res2 = await runShellWithRoot(`
        mkdir -p ${DIR}
        unzip -o ${zipPath} -d ${DIR}/
        `)
            if (!res2.success) return createToast("解压失败！", 'red')

            if (splitMode) {
                createToast("安装分体内核...")
                const coreRes = await runShellWithRoot(`
        gunzip -c /data/kano_mihomo_core.gz > ${DIR}/Proxy/Clash.Core
        rm -f /data/kano_mihomo_core.gz
        `)
                if (!coreRes.success) return createToast("内核落位失败！", 'red')
            }

            createToast("恢复用户配置并收紧权限...")
            const res3 = await runShellWithRoot(`
        [ -f ${DIR}/config.user.bak.yaml ] && cp ${DIR}/config.user.bak.yaml ${CONF}
        mkdir -p ${DIR}/Clash ${DIR}/Proxy/rules ${DIR}/Proxy/etc
        chmod 755 ${DIR} ${DIR}/Scripts ${DIR}/Proxy ${DIR}/Proxy/WebUI
        chmod 700 ${DIR}/Scripts/Clash.Service ${DIR}/Scripts/Clash.Inotify
        chmod 755 ${DIR}/Proxy/Clash.Core
        chmod 600 ${CONF}
        rm -f /data/kano_mihomo.zip /data/kano_mihomo_mini.zip
        `)
            if (!res3.success) return createToast("权限设置失败！", 'red')

            createToast("生成随机管理密钥...")
            const sb = new Uint8Array(16)
            crypto.getRandomValues(sb)
            const newSecret = Array.from(sb).map(b => b.toString(16).padStart(2, '0')).join('')
            const rsec = await runShellWithRoot(`sed -i 's/^secret: ".*"/secret: "${newSecret}"/' ${CONF}`)
            const chksec = await runShellWithRoot(`timeout 2s awk '/^secret/ {print $2}' ${CONF}`)
            if (!rsec.success || !(chksec.content || '').includes(newSecret)) {
                return createToast("随机密钥写入校验失败，安装中止（配置已备份）", 'red', 10000)
            }

            createToast("设置开机自启...")
            const res4 = await runShellWithRoot(`
        grep -qxF '${SERVICE} start' /sdcard/ufi_tools_boot.sh || echo '${SERVICE} start' >> /sdcard/ufi_tools_boot.sh
        grep -qxF 'inotifyd ${DIR}/Scripts/Clash.Inotify "${DIR}/Clash" >> /dev/null &' /sdcard/ufi_tools_boot.sh || echo 'inotifyd ${DIR}/Scripts/Clash.Inotify "${DIR}/Clash" >> /dev/null &' >> /sdcard/ufi_tools_boot.sh
        `)
            if (!res4.success) return createToast("写入自启失败！", 'red')

            // v1.5.0: geo guarantee (bundled in full package; fetched from station when missing)
            if (splitMode || !(await hasGeoFiles())) await ensureGeoFiles()

            createToast("启动内核...")
            const res5 = await runShellWithRoot(`${SERVICE} start`, 30 * 1000)
            if (!res5.success) {
                createToast(`启动失败：${res5.content || ''}（首启需联网拉取规则库，稍后可再点一次启动）`, 'red', 10000)
            } else {
                createToast(`安装完成！日志:${LOG}`, 'green', 5000)
            }
            const secret = await showSecret()
            refreshAll(secret)
            // Auto-refresh after install so the embedded ZashBoard reconnects with the new secret
            createToast("安装完成，2 秒后自动刷新页面…", 'green', 4000)
            setTimeout(() => location.reload(), 2000)
        } finally {
            disabled_btn = false
        }
    }

    // ---------- Uninstall ----------
    const uninstallBtn = document.createElement('button')
    let uninstallCount = 0
    let uninstallTimer = null
    uninstallBtn.textContent = "卸载mihomo"
    uninstallBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        uninstallTimer && clearTimeout(uninstallTimer)
        uninstallTimer = setTimeout(() => uninstallCount = 0, 3000)
        if (uninstallCount++ < 2) return createToast("危险操作！再点一次确认卸载mihomo", 'pink')
        uninstallCount = 0
        createToast("正在停止并卸载...")
        const res = await runShellWithRoot(`
        ${SERVICE} stop
        sleep 1
        rm -rf ${DIR}
        sed -i '/kano_mihomo/d' /sdcard/ufi_tools_boot.sh
        `)
        if (!res.success) return createToast("卸载失败！", 'red')
        createToast("卸载完成（/sdcard/ufi_tools_boot.sh 自启行已清除）", 'green')
        refreshAll()
    }

    // ---------- Start / Stop / Restart ----------
    const startBtn = document.createElement('button')
    startBtn.textContent = "启动"
    startBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (await checkCatConflict()) return
        const res = await runShellWithRoot(`${SERVICE} start`, 30 * 1000)
        createToast((res.content || '').replaceAll('\n', '<br>'), res.success ? 'green' : 'red')
        refreshAll()
    }

    const stopBtn = document.createElement('button')
    stopBtn.textContent = "停止"
    stopBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        const res = await runShellWithRoot(`${SERVICE} stop`, 40 * 1000)
        createToast((res.content || '').replaceAll('\n', '<br>'), res.success ? 'green' : 'red')
        refreshAll()
    }

    const restartBtn = document.createElement('button')
    restartBtn.textContent = "重启"
    restartBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        createToast("重启中...")
        const res = await runShellWithRoot(`
        ${SERVICE} stop
        sleep 1
        ${SERVICE} start
        `, 60 * 1000)
        createToast((res.content || '').replaceAll('\n', '<br>'), res.success ? 'green' : 'red')
        refreshAll()
    }

    // ---------- Boot autostart ----------
    const bootBtn = document.createElement('button')
    bootBtn.id = "km_boot_on"
    bootBtn.textContent = "开机自启"
    bootBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (await checkIsBootUp()) {
            await runShellWithRoot(`sed -i '/kano_mihomo/d' /sdcard/ufi_tools_boot.sh`)
            bootBtn.style.background = ""
            createToast("已取消开机自启", 'green')
        } else {
            await runShellWithRoot(`
        grep -qxF '${SERVICE} start' /sdcard/ufi_tools_boot.sh || echo '${SERVICE} start' >> /sdcard/ufi_tools_boot.sh
        grep -qxF 'inotifyd ${DIR}/Scripts/Clash.Inotify "${DIR}/Clash" >> /dev/null &' /sdcard/ufi_tools_boot.sh || echo 'inotifyd ${DIR}/Scripts/Clash.Inotify "${DIR}/Clash" >> /dev/null &' >> /sdcard/ufi_tools_boot.sh
        `)
            bootBtn.style.background = "var(--dark-btn-color-active)"
            createToast("已设置开机自启", 'green')
        }
    }

    // ---------- Config upload ----------
    const uploadInput = document.createElement('input')
    uploadInput.type = 'file'
    uploadInput.accept = '.yaml,.yml'
    uploadInput.style.display = 'none'
    uploadInput.onchange = async (e) => {
        const file = e.target.files[0]
        uploadInput.value = ''
        if (!file) return
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (file.size > 2 * 1024 * 1024) return createToast("配置文件不能超过2MB！", 'red')
        createToast("上传配置中...")
        const fileData = new File([await file.arrayBuffer()], "km_config.yaml", { type: "text/yaml" })
        const formData = new FormData()
        formData.append("file", fileData)
        const res = await (await fetch(`${KANO_baseURL}/upload_img`, {
            method: "POST", headers: common_headers, body: formData,
        })).json()
        if (!res.url) return createToast("上传失败！", 'red')
        const found = await runShellWithRoot(`ls /data/data/com.minikano.f50_sms/files${res.url}`)
        if (!found.content) return createToast("上传校验失败！", 'red')
        // Back up the current config before upload
        await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml`)
        const mv = await runShellWithRoot(`cp /data/data/com.minikano.f50_sms/files${res.url} ${CONF} && chmod 600 ${CONF}`)
        if (!mv.success) return createToast("配置落位失败！", 'red')
        // v1.5.0: normalize (auto-fill control-plane/geo source; user configs work out of the box)
        if (!(await normalizeConfig())) createToast("归一化补齐未完全成功（面板可能需手动核 secret）", 'pink', 8000)
        // v1.5.1: warn when the uploaded config has no TUN enabled (hotspot clients bypass the core entirely)
        const tunRes = await runShellWithRoot(`sed -n '/^tun:/,/^[a-zA-Z]/p' ${CONF} | grep -q 'enable: *true'`)
        if (!tunRes.success) createToast("配置未启用TUN(tun.enable),热点客户端流量将不经代理", 'pink', 10000)
        createToast("配置已更新，重启内核生效...", 'green')
        restartBtn.click()
    }

    const uploadBtn = document.createElement('button')
    uploadBtn.textContent = "上传配置"
    uploadBtn.onclick = () => uploadInput.click()

    // ---------- Backup config ----------
    const backupBtn = document.createElement('button')
    backupBtn.textContent = "备份配置"
    backupBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        const t = Math.floor(Date.now() + Math.random())
        const res = await runShellWithRoot(`
        rm -f /data/data/com.minikano.f50_sms/files/uploads/km_config_backup*
        cp ${CONF} /data/data/com.minikano.f50_sms/files/uploads/km_config_backup_${t}.yaml
        chmod 777 /data/data/com.minikano.f50_sms/files/uploads/km_config_backup_${t}.yaml
        `)
        if (!res.success) return createToast("备份失败！", 'red')
        const a = document.createElement('a')
        a.download = `mihomo配置备份_${t}.yaml`
        a.href = `/api/uploads/km_config_backup_${t}.yaml`
        a.target = "_blank"
        a.style.display = "none"
        document.body.appendChild(a)
        a.click()
        a.remove()
        createToast("备份已导出", 'green')
    }

    // ---------- Subscription manager (UI to add/remove subscriptions) ----------
    let confirmDel2 = false
    const subBtn = document.createElement('button')
    subBtn.textContent = "订阅管理"
    subBtn.onclick = async () => {
        if (typeof createModal !== 'function') return createToast("当前后台版本过低，订阅管理弹窗不可用（请手改配置yaml）", 'pink', 6000)
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        const readUrl = async (name) => {
            const r = await runShellWithRoot(`grep -A5 "^  ${name}:" ${CONF} | grep -m1 '^    url:'`)
            const m = (r.content || '').match(/url:\s*"?(.*?)"?\s*$/)
            return m ? m[1] : ''
        }
        // Dual-shape compat: full template = two slots; lite template = single slot
        const hasDual = await runShellWithRoot(`grep -c "^  机场1:" ${CONF}`)
        const dual = (hasDual.content || '').trim() !== '0'
        const singleName = '订阅'
        const hasSingle = await runShellWithRoot(`grep -c "^  ${singleName}:" ${CONF}`)
        const single = !dual && (hasSingle.content || '').trim() !== '0'
        if (!dual && !single) {
            return createToast("当前为纯本地节点模式（无订阅槽），导节点请用「导入节点」按钮", "pink", 8000)
        }
        const slots = dual ? ['机场1', '机场2'] : [singleName]
        const slot2 = dual
        const u1 = await readUrl(slots[0])
        const u2 = dual ? await readUrl(slots[1]) : ''
        const hint = dual
            ? `保存=只改订阅链接；删除槽位=从配置移除机场2（分组引用同步清理），删后想恢复请重装依赖包。操作前自动备份配置，改完自动重启内核。`
            : `精简版配置：只有一个订阅槽，填好链接保存即可。操作前自动备份配置，改完自动重启内核。`
        const { id, el } = createModal({
            name: "km_sub_modal", title: "订阅管理", maxWidth: "90%",
            showConfirm: false, onClose: () => true,
            content: `
        <div style="display:flex;flex-direction:column;gap:10px;font-size:.75rem">
        <div>${slots[0]} 订阅链接：<input id="km_sub1" style="width:100%;padding:4px;border-radius:6px;border:none;background:rgba(255,255,255,.08);color:inherit" value="${(u1 || '').replace(/"/g, '&quot;')}"></div>
        <div style="${slot2 ? '' : 'display:none'}">${dual ? slots[1] : ''} 订阅链接：<input id="km_sub2" style="width:100%;padding:4px;border-radius:6px;border:none;background:rgba(255,255,255,.08);color:inherit" value="${(u2 || '').replace(/"/g, '&quot;')}"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button id="km_sub_save1">保存${slots[0]}并重启</button>
            <button id="km_sub_save2" style="${slot2 ? '' : 'display:none'}">保存${dual ? slots[1] : ''}并重启</button>
            <button id="km_sub_del2" style="${slot2 ? '' : 'display:none'}">删除${dual ? slots[1] : ''}槽位</button>
        </div>
        <div style="opacity:.7">${hint}</div>
        </div>`
        })
        showModal(id)
        const escSed = (s) => s.replace(/[&|\\]/g, c => '\\' + c)
        const saveUrl = async (name, url) => {
            await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml`)
            const r = await runShellWithRoot(`sed -i '/^  ${name}:/,/^    path:/ s|^    url: .*|    url: "${escSed(url)}"|' ${CONF}`)
            if (!r.success) return createToast("写入失败", 'red')
            const chk = await runShellWithRoot(`grep -cF 'url: ${url.slice(0, 24).replace(/'/g, '')}' ${CONF}`)
            if ((chk.content || '').trim() === '0') return createToast("写入校验失败，已保留原配置", 'red')
            createToast("订阅已更新，重启内核...", 'green')
            closeModal(id)
            restartBtn.click()
        }
        const s1 = el.querySelector('#km_sub_save1')
        if (s1) s1.onclick = async () => {
            const v = el.querySelector('#km_sub1').value.trim()
            if (!/^https?:\/\//.test(v)) return createToast("请填写 http(s):// 开头的订阅链接", 'red')
            await saveUrl(slots[0], v)
        }
        const s2 = el.querySelector('#km_sub_save2')
        if (s2) s2.onclick = async () => {
            const v = el.querySelector('#km_sub2').value.trim()
            if (!/^https?:\/\//.test(v)) return createToast("请填写 http(s):// 开头的订阅链接", 'red')
            await saveUrl(slots[1], v)
        }
        const d2 = el.querySelector('#km_sub_del2')
        if (d2) d2.onclick = async () => {
            if (!confirmDel2) {
                confirmDel2 = true
                setTimeout(() => confirmDel2 = false, 6000)
                return createToast("将把机场2槽位从配置删除，再点一次确认", 'pink')
            }
            confirmDel2 = false
            await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml`)
            const r = await runShellWithRoot(`
        sed -i '/^  机场2:/,/^    path:/d' ${CONF}
        sed -i '/^  - 机场2$/d' ${CONF}
        `)
            if (!r.success) return createToast("删除失败", 'red')
            const chk = await runShellWithRoot(`grep -c "机场2" ${CONF} || true`)
            if ((chk.content || '').trim() !== '0') return createToast("删除校验未通过（仍残留机场2引用），已保留备份可回滚", 'red', 8000)
            createToast("机场2槽位已删除，重启内核...", 'green')
            closeModal(id)
            restartBtn.click()
        }
    }

    // ---------- Reset config (pull latest template, keep secret and nodes) ----------
    let confirmReset = false
    const resetBtn = document.createElement('button')
    resetBtn.textContent = "重置配置"
    resetBtn.onclick = async () => {
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (!confirmReset) {
            confirmReset = true
            setTimeout(() => confirmReset = false, 8000)
            return createToast("将从站点拉取最新精简配置覆盖当前配置（订阅链接自动保留），再点一次确认", 'pink', 8000)
        }
        confirmReset = false
        const rCur = await runShellWithRoot(`grep -A5 '^  订阅:' ${CONF} | grep -m1 '^    url:'`)
        const m = (rCur.content || '').match(/url:\s*"?(.*?)"?\s*$/)
        const curUrl = m ? m[1] : ''
        const hasCur = /^https?:\/\//.test(curUrl) && !/在这里放置/.test(curUrl)
        createToast("拉取站点最新配置...", '')
        let r = { success: false, content: '' }
        for (const cu of CONFIG_URLS) {
            const candidates = cu.includes('github.com') ? GH_MIRRORS.map(m => m ? m + cu : cu) : [cu]
            for (const full of candidates) {
                r = await runShellWithRoot(`
CURL=/data/data/com.minikano.f50_sms/files/curl
$CURL -kfL --retry 2 -m 120 -o /data/km_config.new.yaml "${full}"
echo "curl_exit=$?"
grep -q "proxy-providers" /data/km_config.new.yaml && echo "CFG_OK" || echo "CFG_BAD"
    `, 150 * 1000)
                if (r.success && (r.content || '').includes('CFG_OK')) break
            }
            if (r.success && (r.content || '').includes('CFG_OK')) break
        }
        if (!r.success || !(r.content || '').includes('CFG_OK')) {
            return createToast(`拉取配置失败：${String(r.content || '').replace(/\s+/g, ' ').slice(-140)}`, 'red', 12000)
        }
        // Keep the current secret (template ships a placeholder; randomized at install time only)
        const curSecret = await showSecret()
        const keepSecret = (await (async () => {
            const rs = await runShellWithRoot(`grep -c 'CHANGE_ME_AT_INSTALL' /data/km_config.new.yaml || true`)
            return (rs.content || '').trim() !== '0'
        })()) && curSecret && !/CHANGE_ME/.test(curSecret) ? curSecret : null
        await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml`)
        const esc = curUrl.replace(/[&|\\]/g, ch => '\\' + ch)
        let sedLine = hasCur ? `sed -i '/^  订阅:/,/^    path:/ s|^    url: .*|    url: "${esc}"|' /data/km_config.new.yaml\n        ` : ''
        if (keepSecret) sedLine += `sed -i 's/^secret: ".*"/secret: "${keepSecret}"/' /data/km_config.new.yaml\n        `
        const r2 = await runShellWithRoot(`
        ${sedLine}mv -f /data/km_config.new.yaml ${CONF}
        chmod 600 ${CONF}
        `)
        if (!r2.success) return createToast("配置落位失败", 'red')
        // v1.5.0: normalization + geo guarantee (reset doubles as self-heal for missing geo files)
        await normalizeConfig(keepSecret)
        if (!(await hasGeoFiles())) await ensureGeoFiles()
        createToast(hasCur ? "配置已重置（订阅链接已保留），重启内核..." : "配置已重置，重启内核...", 'green')
        restartBtn.click()
    }

    // ---------- Import node file (on-device channel; credentials never touch any third party) ----------
    const importInput = document.createElement('input')
    importInput.type = 'file'
    importInput.accept = '.yaml,.yml,.txt,.conf'
    importInput.style.display = 'none'
    importInput.onchange = async (e) => {
        const file = e.target.files[0]
        importInput.value = ''
        if (!file) return
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (file.size > 2 * 1024 * 1024) return createToast("节点文件不能超过2MB！", 'red')
        createToast("导入节点文件中（设备内部通道，不经过任何第三方）...")
        const buf = await file.arrayBuffer()
        const formData = new FormData()
        formData.append("file", new File([buf], "km_nodes_import.yaml", { type: "text/plain" }))
        const res = await (await fetch(`${KANO_baseURL}/upload_img`, {
            method: "POST", headers: common_headers, body: formData,
        })).json()
        if (!res.url) return createToast("上传失败！", 'red')
        const found = await runShellWithRoot(`ls /data/data/com.minikano.f50_sms/files${res.url}`)
        if (!found.content) return createToast("上传校验失败！", 'red')
        await runShellWithRoot(`cp ${DIR}/Proxy/proxy_providers/我的节点.yaml ${DIR}/nodes.bak.yaml 2>/dev/null`)
        const mv = await runShellWithRoot(`
        cp /data/data/com.minikano.f50_sms/files${res.url} ${DIR}/Proxy/proxy_providers/我的节点.yaml
        chmod 600 ${DIR}/Proxy/proxy_providers/我的节点.yaml
        `)
        if (!mv.success) return createToast("节点文件落位失败！", 'red')
        createToast("节点文件已导入，重启内核...", 'green')
        restartBtn.click()
    }

    const importBtn = document.createElement('button')
    importBtn.textContent = "导入节点"
    importBtn.onclick = () => importInput.click()

    // ---------- Logs ----------
    const logBtn = document.createElement('button')
    logBtn.textContent = "内核日志"
    logBtn.onclick = async () => {
        if (typeof createModal !== 'function') return createToast("当前后台版本过低，日志弹窗不可用（可看 /sdcard/mihomo内核日志.txt）", 'pink', 6000)
        const res = await runShellWithRoot(`timeout 2s awk '{print}' ${LOG} | tail -n 40`)
        const { id } = createModal({
            name: "km_log_modal", title: `mihomo 内核日志（最近40行）`, maxWidth: "90%",
            showConfirm: false, onClose: () => true,
            content: `<textarea disabled style="width:100%;height:300px;font-size:12px;border:none;background:transparent;white-space:pre;">${(res.content || '（无日志）').replace(/</g, '&lt;')}</textarea>`
        })
        showModal(id)
    }

    // ---------- Dashboard info ----------
    const infoBtn = document.createElement('button')
    infoBtn.textContent = "面板信息"
    infoBtn.onclick = async () => {
        if (typeof createModal !== 'function') {
            const secret = await showSecret()
            return createToast(`面板:http://${UFI_DATA.lan_ipaddr || '设备IP'}:${CTRL_PORT}/ui/ 密钥:${secret}`, '', 15000)
        }
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        const secret = await showSecret()
        const coreLive = await liveCoreVer()
        const geoOK = await hasGeoFiles()
        const { id } = createModal({
            name: "km_info_modal", title: "ZashBoard 面板信息", maxWidth: "90%",
            showConfirm: false, onClose: () => true,
            content: `
        <div style="font-size:.75rem;line-height:2">
        <div>面板地址：<b>http://${UFI_DATA.lan_ipaddr || '设备IP'}:${CTRL_PORT}/ui/</b></div>
        <div>API密钥：<b>${secret || '(读取失败)'}</b>（安装时随机生成，重装/重置自动保留）</div>
        <div>内核版本：${coreLive || CORE_TAG + '（未实查到）'}（官方 android-arm64）</div>
        <div>geo 库：${geoOK ? '已就位' : '<span style="color:#f87171">缺失（点「重置配置」补齐）</span>'}</div>
        <div>插件版本：${PLUGIN_VER} ｜ By_Jace</div>
        </div>`
        })
        showModal(id)
    }

    // ---------- Online core upgrade ----------
    const upgradeBtn = document.createElement('button')
    upgradeBtn.textContent = `升级内核`
    upgradeBtn.onclick = async () => {
        if (await checkWeak()) return
        if (!(await checkAdvanceFunc())) return createToast("没有开启高级功能，无法使用！", 'red')
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        if (typeof createFixedToast !== 'function') return createToast("当前后台版本过低，在线升级不可用（可重装依赖包实现升级）", 'pink', 6000)
        if (!confirmOnlineUpgrade) {
            confirmOnlineUpgrade = true
            setTimeout(() => confirmOnlineUpgrade = false, 8000)
            return createToast(`将下载官方最新 android-arm64 内核并替换（当前${CORE_TAG}）。再点一次确认开始。`, 'pink', 8000)
        }
        confirmOnlineUpgrade = false
        const fixedToast = createFixedToast("km_upgrading", "升级内核：下载中(可能较慢，不要离开页面)...")
        let ok = false, lastErr = ''
        const resUp = await dlVerifyAny([CORE_URL_PATH], `${DIR}/Proxy/Clash.Core.dl.gz`, CORE_GZ_SHA, 300 * 1000)
        ok = resUp.ok
        lastErr = resUp.content
        if (!ok) {
            fixedToast.close()
            return createToast(`下载失败：${lastErr}。可手动下载 mihomo-android-arm64-v8-*.gz 传入后重装`, 'red', 10000)
        }
        fixedToast.el && (fixedToast.el.querySelector('#km_upgrading') ? fixedToast.el.textContent = "升级内核：解压替换中..." : null)
        const res2 = await runShellWithRoot(`
        cd ${DIR}/Proxy
        gunzip -f Clash.Core.dl.gz
        chmod 755 Clash.Core.dl
        ${SERVICE} stop
        mv -f Clash.Core.dl Clash.Core
        sleep 1
        ${SERVICE} start
        `, 90 * 1000)
        fixedToast.close()
        if (!res2.success) return createToast(`替换失败：${res2.content || ''}`, 'red', 8000)
        createToast(`内核已升级并重启 ✓ ${(res2.content || '').replaceAll('\n', '<br>')}`, 'green', 8000)
        refreshAll()
    }
    let confirmOnlineUpgrade = false

    // ---------- UI mount ----------
    let disabled_btn = false
    let statusInterval = null

    const refreshAll = async (secret) => {
        const installed = await isInstalled()
        ;[startBtn, stopBtn, restartBtn, uninstallBtn, uploadBtn, backupBtn, subBtn, importBtn, resetBtn, infoBtn, upgradeBtn].forEach(b => b.disabled = !installed)
        installBtn.disabled = false
        if (!installed) { bootBtn.style.background = ""; updateStatusEl('未安装') ; return }
        const boot = await checkIsBootUp()
        bootBtn.style.background = boot ? "var(--dark-btn-color-active)" : ""
        const running = await isRunning()
        updateStatusEl(running ? '● 运行中' : '○ 已停止', running)
        // Never call refreshFrameIfOpen() from polling callbacks (full iframe reload disrupts the dashboard)
    }

    const updateStatusEl = (text, running) => {
        const el = document.querySelector('#km_status')
        if (!el) return
        el.textContent = text
        el.style.color = running ? '#4ade80' : '#9ca3af'
    }

    const mmContainer = document.querySelector('.functions-container')
    mmContainer.insertAdjacentHTML("afterend", `
            <div id="IFRAME_KANO_MIHOMO" style="width: 100%; margin-top: 10px;">
                <div class="title" style="margin: 6px 0 ;">
                    <strong>mihomo 内核(强化版)</strong>
                    <span id="km_status" style="font-size:.7rem;margin-left:6px;"></span>
                    <div style="display: inline-block;" id="collapse_km_btn"></div>
                </div>
                <div class="collapse" id="collapse_km" data-name="close" style="height: 0px; overflow: hidden;">
                    <div class="collapse_box">
                        <div id="km_action_box" style="margin-bottom:10px;display:flex;gap:10px;flex-wrap:wrap"></div>
                        <ul class="deviceList">
                            <li style="padding:10px">
                                <iframe id="km_iframe" src="javascript:;" style="border:none;padding:0;margin:0;width:100%;height:500px;border-radius: 10px;overflow: hidden;"></iframe>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            `)
    document.body.appendChild(uploadInput)
    document.body.appendChild(importInput)

    // Refresh iframe (hostname/port/secret params = ZashBoard auto-connect, no manual secret entry)
    // Called only on panel expand / manual trigger, never from polling
    const refreshFrameIfOpen = async (force = false) => {
        if (!force && localStorage.getItem("#collapse_km") != 'open') return
        if (!UFI_DATA.lan_ipaddr) return
        const secret = (await showSecret()) || ''
        document.getElementById('km_iframe').src = `http://${UFI_DATA.lan_ipaddr}:${CTRL_PORT}/ui/?hostname=${UFI_DATA.lan_ipaddr}&port=${CTRL_PORT}&secret=${encodeURIComponent(secret)}&label=F50&t=` + Date.now()
    }

    const box = document.querySelector('#km_action_box')
    ;[installBtn, uninstallBtn, startBtn, stopBtn, restartBtn, bootBtn, uploadBtn, backupBtn, subBtn, importBtn, resetBtn, logBtn, infoBtn, upgradeBtn].forEach(b => {
        b.classList.add('btn')
        box.appendChild(b)
    })

    collapseGen("#collapse_km_btn", "#collapse_km", "#collapse_km", (newVal) => {
        statusInterval && statusInterval()
        if (newVal == 'open') {
            refreshAll()
            statusInterval = requestInterval(() => refreshAll(), 3000)
            setTimeout(refreshFrameIfOpen, 300)
        }
    })

    ;(async () => {
        const wait = (ms = 200) => new Promise(r => setTimeout(r, ms))
        let n = 0
        while (!UFI_DATA.lan_ipaddr && n++ < 50) await wait()
        // Version guard deferred: UFI_DATA loads async, app_ver reads empty at injection time
        // and only fires when the modal API is truly missing; core features do not depend on it
        try {
            const ver = String(UFI_DATA.app_ver || '').split('.').map(Number)
            const verNum = (ver[0] || 0) * 10000 + (ver[1] || 0) * 100 + (ver[2] || 0)
            if (verNum && verNum < 30900 && typeof createModal !== 'function') {
                createToast("mihomo插件：日志/面板信息弹窗需要 UFI-TOOLS 3.9.0+，其余功能不受影响", 'pink', 8000)
            }
        } catch (e) { }
        if (localStorage.getItem("#collapse_km") == 'open') {
            refreshAll()
            statusInterval = requestInterval(() => refreshAll(), 3000)
            setTimeout(refreshFrameIfOpen, 300)
        } else {
            refreshAll()
        }
        // v1.5.0: update check on load (station version.json; fully silent when clean)
        setTimeout(checkUpdates, 1500)
    })()
})()
//</script>
