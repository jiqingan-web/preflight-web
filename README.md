# 航前文档助手 · 纯网页版

原 Python 服务端版（`~/workspace/preflight-check/航前文档助手`）的静态站点移植：
没有服务器、没有访问口令接口，OCR、信息提取、Word 生成全部在浏览器内完成，
可直接挂 GitHub Pages。提取与生成的行为与 Python 版逐项对齐（见 `tests/`）。

## 目录

- `index.html` — 页面（沿用原版界面与流程，另加数据口令门）
- `js/extract.js` — `extract_hints` / `extract_flights` / 机场匹配 / 日期校验的移植
- `js/docx.js` — `update_docx` / `generate_document` / 监控信息提取的移植（JSZip + DOM）
- `js/crypto.js` — 数据包 AES-GCM 加解密（WebCrypto，PBKDF2-HMAC-SHA256 210,000 次）
- `js/app.js` — 界面逻辑：数据加载/解锁、Tesseract.js OCR（chi_sim+eng、psm 6）、本地提取与生成、下载/分享
- `tools/pack.mjs` — 打包脚本（见下）
- `tests/` — Node 测试：移植 Python 测试的全部提取用例、文档生成用例、打包往返
- `data.enc` — 加密数据包（机场库 + 模板 + 监控默认值）。**当前仓库里这份是用演示口令 `test-pass` 打的，发布前务必用自己的口令重打。**

## 数据保护

GitHub Pages 是公开的，所以机场库、Word 模板与监控默认值不以明文发布：
三者组装成一个 JSON（模板 base64 内嵌），经 PBKDF2 派生密钥后 AES-GCM 加密为
`data.enc`。页面打开时先让用户输入口令，在内存中解密；口令错误会明确报错。
口令只通过环境变量传入打包脚本，不写进任何文件。

## 本地运行

```bash
cd ~/workspace/preflight-web
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

仓库自带的 `data.enc` 口令是 `test-pass`，打开页面输入即可体验完整流程。

想要免口令的明文本地模式（数据会以明文出现在目录里，勿发布）：

```bash
node tools/pack.mjs --plain   # 产出 data.json + template.docx
rm data.enc                    # 页面优先读 data.enc，明文模式需先移走它
```

## 重新打包（机场库或模板更新后）

```bash
npm install   # 首次需要，打包脚本依赖 jszip 与 @xmldom/xmldom
PREFLIGHT_PACK_KEY='你的口令' node tools/pack.mjs
```

打包脚本默认从原始项目 `~/workspace/preflight-check/航前文档助手` 读取
`data/airports.json` 与 `assets/template.docx`（可用 `--src 目录` 改），
监控默认值用与原 `get_monitor_info` 相同的逻辑从模板现算。

## 发布到 GitHub Pages（概要）

1. 用自己的口令重新打包，确认根目录只有 `data.enc`、没有 `data.json`/`template.docx` 明文。
2. 把本站点文件（`index.html`、`js/`、`data.enc`）推到仓库。
3. 仓库 Settings → Pages → 选择分支与根目录发布。

注意：页面与 OCR 模型从 jsDelivr CDN 加载（Tesseract.js、JSZip），
首次识别需联网下载识别模型与语言包，之后浏览器会缓存。

## 测试

```bash
npm install
npm test    # 24 个用例：提取 15 + 文档生成 6 + 打包往返 3
```
