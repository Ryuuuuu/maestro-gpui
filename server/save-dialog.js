import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);
const windowsDialog = `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Windows.Forms
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $dialog = New-Object System.Windows.Forms.SaveFileDialog
  $dialog.InitialDirectory = $env:MAESTRO_DIALOG_DIRECTORY
  $dialog.FileName = $env:MAESTRO_DIALOG_NAME
  $dialog.Filter = $env:MAESTRO_DIALOG_FILTER
  $dialog.DefaultExt = $env:MAESTRO_DIALOG_EXT
  $dialog.RestoreDirectory = $true
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  try {
    if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Write($dialog.FileName) }
  } finally { $dialog.Dispose(); $owner.Dispose() }
`;
const macDialog = `on run argv
  try
    set destination to choose file name with prompt (item 3 of argv) default location (POSIX file (item 1 of argv) as alias) default name (item 2 of argv)
    return POSIX path of destination
  on error number -128
    return ""
  end try
end run`;

export async function chooseFlowPath(directory, name, ext = "yaml") {
  let result;
  if (process.platform === "win32") {
    result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-EncodedCommand",
        Buffer.from(windowsDialog, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          MAESTRO_DIALOG_DIRECTORY: directory,
          MAESTRO_DIALOG_NAME: name,
          MAESTRO_DIALOG_EXT: ext,
          MAESTRO_DIALOG_FILTER: ext === "mitm" ? "mitmproxy (*.mitm)|*.mitm" : "Maestro YAML (*.yaml;*.yml)|*.yaml;*.yml",
        },
      },
    );
  } else if (process.platform === "darwin") {
    result = await run("osascript", ["-e", macDialog, directory, name, ext === "mitm" ? "통신 기록 저장" : "Save Maestro flow"]);
  } else {
    const path = join(directory, name);
    try {
      result = await run("zenity", [
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        "--filename=" + path,
      ]);
    } catch (error) {
      if (error.code === 1 && !error.stderr) return null;
      if (error.code !== "ENOENT") throw error;
      try {
        result = await run("kdialog", [
          "--getsavefilename",
          path,
          ext === "mitm" ? "*.mitm" : "*.yaml *.yml",
        ]);
      } catch (fallback) {
        if (fallback.code === 1 && !fallback.stderr) return null;
        if (fallback.code === "ENOENT")
          throw new Error("저장 창을 열려면 zenity 또는 kdialog를 설치하세요.");
        throw fallback;
      }
    }
  }
  return result.stdout.replace(/\r?\n$/, "") || null;
}
