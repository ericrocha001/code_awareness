const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { buildSync } = require('esbuild')
const { clipboard, ipcMain } = require('electron')
const sharp = require('sharp')

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'; export { RepositoryContinuumSession } from './src/main/continuum/project-continuum-session'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', alias: { sharp: require.resolve('sharp') }, external: ['electron', 'better-sqlite3', require.resolve('sharp')] })
  const { registerContinuumHandlers, RepositoryContinuumSession } = require(backend)
  const repositoryPath = path.join(ctx.temporary, 'repository')
  fs.mkdirSync(repositoryPath)
  const session = new RepositoryContinuumSession(path.join(ctx.temporary, 'storage'), { findByPath: candidate => ({ id: 'export-acceptance', localCheckout: { path: candidate } }) })
  session.activate(repositoryPath)
  const unsubscribe = registerContinuumHandlers(session)
  const service = session.getActiveService()
  const text = '\uFEFF---\r\nname: Literal export\r\ndescription: Isolated native export proof\r\nkind: DOCUMENT\r\ndate: 2026-10-21T12:00:00-03:00\r\ntechnical: true\r\n---\r\n# Literal Markdown\r\n\r\nç 日本語 🚀\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n```ts\r\nconst literal = `${value}`\r\n```\r\n'
  const markdown = service.publish(text)
  const webp = await sharp({ create: { width: 240, height: 160, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).webp({ lossless: true }).toBuffer()
  const visual = await service.publishVisual('---\nname: Transparent visual\ndescription: Original WebP proof\nkind: VISUAL_REFERENCE\n---\n# Visual\n', webp)
  const originalText = service.get(markdown.artifactId).rawMarkdown
  const originalVisualText = service.get(visual.artifactId).rawMarkdown
  const digest = value => createHash('sha256').update(value).digest('hex')
  const clipboardBefore = { text: clipboard.readText(), image: clipboard.readImage() }
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'continuum-publication-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const helper = path.join(ctx.temporary, 'save-dialog.ps1')
  fs.writeFileSync(helper, `param([int]$TargetPid, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OwnedDialog {
  public delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Visit callback, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr parameter, string value);
}
"@
$deadline = [DateTime]::UtcNow.AddSeconds(18)
while ([DateTime]::UtcNow -lt $deadline) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    if ($window.Current.ClassName -ne '#32770') { continue }
    $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
    $fields = New-Object System.Collections.Generic.List[System.IntPtr]
    $buttons = New-Object System.Collections.Generic.List[System.IntPtr]
    $visitor = [OwnedDialog+Visit] {
      param($handle, $unused)
      $className = New-Object System.Text.StringBuilder 256
      [void][OwnedDialog]::GetClassName($handle, $className, 256)
      $id = [OwnedDialog]::GetDlgCtrlID($handle)
      if ($className.ToString() -eq 'Edit') { Write-Output ('EDIT_ID: ' + $id) | Out-Null; $fields.Add($handle) }
      if ($className.ToString() -eq 'Button' -and $id -eq 1) { $buttons.Add($handle) }
      return $true
    }
    [void][OwnedDialog]::EnumChildWindows([IntPtr]$window.Current.NativeWindowHandle, $visitor, [IntPtr]::Zero)
    $edit = $fields | Where-Object { [OwnedDialog]::GetDlgCtrlID($_) -eq 1001 } | Select-Object -First 1
    if ($edit -and $buttons.Count -gt 0) {
      [void][OwnedDialog]::SendMessage($edit, 12, [IntPtr]::Zero, $Destination)
      [void][OwnedDialog]::SendMessage($buttons[0], 245, [IntPtr]::Zero, $null)
      Start-Sleep -Seconds 2
      $remaining = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
      $dialogs = @($remaining | Where-Object { $_.Current.ClassName -eq '#32770' })
      if ($dialogs.Count -gt 0) {
        foreach ($owned in $dialogs) {
          Write-Output ('DIALOG: ' + $owned.Current.Name)
          foreach ($control in $owned.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($control.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.Button','ControlType.Text')) { Write-Output ($control.Current.AutomationId + ': ' + $control.Current.Name) }
          }
        }
        throw 'Native save dialog remains open after invocation'
      }
      Write-Output 'NATIVE_SAVE_DIALOG_ACCEPTED'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 100
}
throw 'Owned native Save dialog controls not found'
`)
  const nativeSave = async (destination) => {
    const automation = new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-File', helper, '-TargetPid', String(process.pid), '-Destination', destination], { windowsHide: true, timeout: 22000 }, (error, stdout, stderr) => { fs.appendFileSync(path.join(ctx.evidenceDir, 'native-dialog.log'), stdout + stderr); error ? reject(new Error((stdout + stderr) || error.message)) : resolve(stdout) }))
    await ctx.click('.continuum-export-actions button:nth-child(2)')
    ctx.check('Windows native Save dialog accepted by process-scoped Win32 controls', (await automation).includes('NATIVE_SAVE_DIALOG_ACCEPTED'))
    await ctx.waitFor(() => document.querySelector('.continuum-export-feedback')?.textContent === 'Artifact salvo.' || !!document.querySelector('.continuum-export-feedback[role=alert]'))
    const feedback = await ctx.evaluate(() => document.querySelector('.continuum-export-feedback')?.textContent)
    ctx.check('Native save completes: ' + feedback, feedback === 'Artifact salvo.')
  }
  const select = async id => {
    await ctx.click(`[data-artifact-id="${id}"]`)
    await ctx.waitFor(value => document.querySelector('.continuum-identity')?.textContent === value && !!document.querySelector('.continuum-export-actions'), id)
  }
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath } })
    await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length === 2)
    await ctx.viewport(1440, 900)
    ctx.check('Context groups start collapsed', await ctx.evaluate(() => document.querySelectorAll('.continuum-facet-groups details[open]').length === 0))
    await ctx.click('.continuum-context-actions > button')
    await ctx.waitFor(() => !!document.querySelector('.continuum-facet-options'))
    ctx.check('Technical facets remain eligible', await ctx.evaluate(() => [...document.querySelectorAll('.continuum-facet-options label')].some(label => label.textContent === 'technical')))
    await select(markdown.artifactId)
    await ctx.capture('context-personalization-dark')
    await ctx.click('.continuum-export-actions button')
    await ctx.waitFor(() => document.querySelector('.continuum-export-feedback')?.textContent.includes('Copiado'))
    ctx.check('Native Windows clipboard text is the exact canonical Markdown', clipboard.readText() === text)
    await ctx.evaluate(() => { const editor = document.createElement('textarea'); editor.id = 'paste-text'; editor.setAttribute('aria-label', 'Native paste editor'); document.body.append(editor); editor.focus() })
    ctx.window.webContents.paste()
    await ctx.waitFor(() => document.querySelector('#paste-text').value.includes('const literal'))
    ctx.check('Native paste in a text editor retains YAML, table and code syntax', await ctx.evaluate(expected => document.querySelector('#paste-text').value === expected.replace(/\r\n/g, '\n'), text))
    await ctx.evaluate(() => document.querySelector('#paste-text').remove())
    const mdPath = path.join(ctx.evidenceDir, 'exported.md')
    await nativeSave(mdPath)
    ctx.check('Saved Markdown preserves exact UTF-8/BOM/CRLF bytes', fs.readFileSync(mdPath).equals(Buffer.from(text, 'utf8')))
    await select(visual.artifactId)
    await ctx.waitFor(() => !!document.querySelector('.continuum-visual-preview'))
    await ctx.click('.continuum-export-actions button')
    await ctx.waitFor(() => document.querySelector('.continuum-export-feedback')?.textContent.includes('Copiado'))
    const png = clipboard.readImage().toPNG()
    const sourcePixels = await sharp(webp).ensureAlpha().raw().toBuffer()
    ctx.check('Windows clipboard image retains original pixels and alpha', (await sharp(png).ensureAlpha().raw().toBuffer()).equals(sourcePixels))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'clipboard.png'), png)
    await ctx.evaluate(() => {
      const editor = document.createElement('div'); editor.id = 'paste-image'; editor.contentEditable = 'true'; editor.style.cssText = 'position:fixed;inset:150px 300px;background:repeating-conic-gradient(#ddd 0% 25%,white 0% 50%) 0/20px 20px;z-index:10'; editor.setAttribute('aria-label', 'Visual paste editor')
      editor.addEventListener('paste', event => { const item = [...event.clipboardData.items].find(item => item.type === 'image/png'); if (!item) return; event.preventDefault(); const image = document.createElement('img'); image.src = URL.createObjectURL(item.getAsFile()); editor.append(image) })
      document.body.append(editor); editor.focus()
    })
    ctx.window.webContents.paste()
    await ctx.waitFor(() => document.querySelector('#paste-image img')?.naturalWidth === 240)
    ctx.check('Image is natively pastable as PNG in a visual editor', await ctx.evaluate(() => document.querySelector('#paste-image img').naturalHeight === 160))
    await ctx.capture('native-image-pasted')
    await ctx.evaluate(() => document.querySelector('#paste-image').remove())
    const webpPath = path.join(ctx.evidenceDir, 'exported.webp')
    await nativeSave(webpPath)
    const saved = fs.readFileSync(webpPath)
    ctx.check('WebP export preserves original byte length and SHA-256', saved.length === webp.length && digest(saved) === digest(webp))
    ctx.check('Export never mutates the Store or original media', service.get(markdown.artifactId).rawMarkdown === originalText && service.get(visual.artifactId).rawMarkdown === originalVisualText && service.getVisual(visual.artifactId).data.equals(webp))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
    await ctx.viewport(1000, 760)
    await ctx.overflow()
    await ctx.capture('inspector-export-light')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'fidelity.json'), JSON.stringify({ markdownBytes: Buffer.byteLength(text), webpBytes: webp.length, originalSHA256: digest(webp), savedSHA256: digest(saved), clipboard: 'PNG pixels and alpha compared; native paste in isolated Electron visual editor', dialog: 'Real Windows Save dialog, process-scoped Win32 controls' }, null, 2))
  } finally {
    clipboard.write({ text: clipboardBefore.text, ...(!clipboardBefore.image.isEmpty() ? { image: clipboardBefore.image } : {}) })
    unsubscribe(); session.dispose()
    for (const channel of ['export', 'get', 'list', 'facets', 'graph', 'suggestions', 'publish', 'publish-visual', 'get-visual', 'get-visual-thumbnail']) ipcMain.removeHandler(`continuum:${channel}`)
  }
}
