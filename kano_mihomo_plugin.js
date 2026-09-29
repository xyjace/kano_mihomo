//<script>
// ============================================================
// mihomo 内核插件（强化版）v1.3.0  By_Jace 2026-09-29
// 基于 kanoqwq 猫猫Clash插件2.4（MIT）修改强化：TUN+FORWARD 架构沿用其已实机验证方案
// 能力：官方内核在线安装(整包/迷你分体双路) / 订阅管理(双形态槽位)
//       / 重置配置(站点拉最新) / 在线升级内核 / 全程sha256校验
// 安全：强密钥 + CORS全关 + 权限收紧（猫猫包两处硬伤已修复）
// 配置形态：精简版（单订阅槽+节点选择/自动选择+CN直连分流）
// ============================================================
(() => {
    const PLUGIN_VER = "1.3.0"
    const CORE_TAG = "v1.19.31"
    const DIR = "/data/kano_mihomo"
    const SERVICE = `${DIR}/Scripts/Clash.Service`
    const CONF = `${DIR}/Proxy/config.yaml`
    const LOG = "/sdcard/mihomo内核日志.txt"
    const CTRL_PORT = 7788
    // 升级内核：依次尝试的下载前缀（空=直连GitHub）
    const GH_MIRRORS = ["", "https://gh-proxy.com/", "https://ghfast.top/"]
    const CORE_URL_PATH = `https://github.com/MetaCubeX/mihomo/releases/download/${CORE_TAG}/mihomo-android-arm64-v8-${CORE_TAG}.gz`
    // 本地安装包查找顺序（远程安装可走下面的在线下载兜底）
    const ZIP_CANDIDATES = ["/sdcard/kano_mihomo.zip", "/sdcard/Download/kano_mihomo.zip", "/sdcard/下载/kano_mihomo.zip", "/data/data/com.minikano.f50_sms/files/uploads/kano_mihomo.zip"]
    // 在线下载（云端下载站隐藏链）+ sha256 校验（防截断/防篡改）
    // ⚠️ URL必须与云端实际建链一致（v1.0.2教训：占位URL忘替换导致设备拉404）
    const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/` // 公开兜底源（仓库内不挂私有站点链接）
    const GITHUB_REPO = "xyjace/kano_mihomo" // 发布时替换为真实 owner/repo
    const RELEASE_TAG = "v1.3.0"
    const RELEASE_BASE = `https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}/`
    const ZIP_URLS = [RELEASE_BASE + "kano_mihomo.zip"]
    const MINI_URLS = [RELEASE_BASE + "kano_mihomo_mini.zip"]
    const CONFIG_URLS = [RELEASE_BASE + "config-lite.yaml"]
    const ZIP_FULL_SHA = "8644c7e1e2487165d48f7bde7da94bc724d86fc4f6dea9fde8fcaecee01e7c6c"
    const ZIP_MINI_SHA = "78be7c8ee7ea2dfaa0f03ea9e7c78946e87d8ed2e0fc4c17175aaaaace0be3c4"
    const CORE_GZ_SHA = "de00bc53ed151636ca078c812a82a5315687d8d52164db230f1935b2a37904f6"
    const CONFIG_URL = RAW_BASE + "package/Proxy/config.template.yaml"

    // 下载+sha256校验（-k容忍老CA；失败回显curl退出码与文件大小便于诊断）
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

    // 多源×镜像下载轮询（github源走镜像前缀，非github源直连）
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

    // 猫猫插件互斥检测：两包都用 TUN 设备 Meta，并存必然打架
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

    // ---------- 安装 ----------
    const installBtn = document.createElement('button')
    installBtn.textContent = `安装mihomo(${CORE_TAG})`
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
                // 分体兜底：迷你配置包(7.5KB，弱网也下得动) + 内核走国内镜像
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

            createToast("启动内核...")
            const res5 = await runShellWithRoot(`${SERVICE} start`, 30 * 1000)
            if (!res5.success) {
                createToast(`启动失败：${res5.content || ''}（首启需联网拉取规则库，稍后可再点一次启动）`, 'red', 10000)
            } else {
                createToast(`安装完成！日志:${LOG}`, 'green', 5000)
            }
            const secret = await showSecret()
            refreshAll(secret)
        } finally {
            disabled_btn = false
        }
    }

    // ---------- 卸载 ----------
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

    // ---------- 启动/停止/重启 ----------
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

    // ---------- 开机自启 ----------
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

    // ---------- 配置上传 ----------
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
        // 上传前先备份现配置
        await runShellWithRoot(`cp ${CONF} ${DIR}/config.user.bak.yaml`)
        const mv = await runShellWithRoot(`cp /data/data/com.minikano.f50_sms/files${res.url} ${CONF} && chmod 600 ${CONF}`)
        if (!mv.success) return createToast("配置落位失败！", 'red')
        createToast("配置已更新，重启内核生效...", 'green')
        restartBtn.click()
    }

    const uploadBtn = document.createElement('button')
    uploadBtn.textContent = "上传配置"
    uploadBtn.onclick = () => uploadInput.click()

    // ---------- 备份配置 ----------
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

    // ---------- 订阅管理（页面化增删订阅槽位，v1.0.4） ----------
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
        // 双形态兼容：完整版=机场1/机场2 双槽；精简版=单槽「订阅」
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

    // ---------- 重置配置（拉取站点最新精简配置，保留订阅链接，v1.1.0） ----------
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
        // 保留现有密钥（模板密钥为占位符，安装时才随机生成）
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
        createToast(hasCur ? "配置已重置（订阅链接已保留），重启内核..." : "配置已重置，重启内核...", 'green')
        restartBtn.click()
    }

    // ---------- 导入节点文件（设备内部通道，节点凭据不经任何第三方，v1.2.0） ----------
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

    // ---------- 日志 ----------
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

    // ---------- 面板信息 ----------
    const infoBtn = document.createElement('button')
    infoBtn.textContent = "面板信息"
    infoBtn.onclick = async () => {
        if (typeof createModal !== 'function') {
            const secret = await showSecret()
            return createToast(`面板:http://${UFI_DATA.lan_ipaddr || '设备IP'}:${CTRL_PORT}/ui/ 密钥:${secret}`, '', 15000)
        }
        if (!(await isInstalled())) return createToast("请先安装！", 'red')
        const secret = await showSecret()
        const { id } = createModal({
            name: "km_info_modal", title: "ZashBoard 面板信息", maxWidth: "90%",
            showConfirm: false, onClose: () => true,
            content: `
        <div style="font-size:.75rem;line-height:2">
        <div>面板地址：<b>http://${UFI_DATA.lan_ipaddr || '设备IP'}:${CTRL_PORT}/ui/</b></div>
        <div>API密钥：<b>${secret || '(读取失败)'}</b>（安装时随机生成，重装/重置自动保留）</div>
        <div>内核版本：${CORE_TAG}（官方 android-arm64）｜ By_Jace 出品</div>
        <div>订阅导入：点插件面板「订阅管理」按钮粘贴链接即可，无需改配置文件</div>
        <div style="opacity:.75">订阅链接哪里拿：①手机 FlClash→配置→点正在用的配置 ②机场官网「复制订阅链接」③旧猫猫配置备份的 url: 行</div>
        <div>插件版本：${PLUGIN_VER}</div>
        </div>`
        })
        showModal(id)
    }

    // ---------- 在线升级内核 ----------
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

    // ---------- UI 挂载 ----------
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
        // 注意：此处严禁调用 refreshFrameIfOpen()——本函数在3秒轮询里，
        // 调它=iframe每3秒整页重载（v1.0.2"频繁在刷"根因）
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

    // 刷新iframe（带hostname/port/secret参数=ZashBoard自动连接后端，免手输密钥）
    // 只在展开面板/手动触发时调用，绝不放进轮询
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
        // 版本守卫后移：UFI_DATA 异步加载，注入瞬间读 app_ver 必为空（1.0.0 误报根因）
        // 且只在弹窗函数真缺失时才拦截——核心功能(安装/启停/上传)不依赖 createModal
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
    })()
})()
//</script>
