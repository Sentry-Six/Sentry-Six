; Sentry Studio's Windows installer, SentryStudioSetup<version>.exe (NSIS 3.08
; or newer). tools/package-windows.sh builds it.
;
; It takes the place of Electron Studio's electron-builder installer, so that
; installed copies of Electron Studio update to this app through
; electron-updater: the same uninstall registry key (electron-builder's app
; GUID), the same per-user install folder and the same shortcut names. When it
; finds Electron Studio's files in the install folder it removes them; the
; settings in %APPDATA%\Sentry Studio are never touched.
;
; Command line, as electron-updater and the app's own updater run it:
;   --updated     an update: no folder page, close the running app without
;                 asking, and pass --updated to the app when starting it
;   /S            silent
;   --force-run   start the app when done
;   /D=<folder>   install folder (must be last), else the installed copy's,
;                 else %LOCALAPPDATA%\Programs\Sentry Studio
; The uninstaller takes /S, --updated and --keep-shortcuts, as electron-
; builder's does.
;
; Defines (-D): VERSION (x.y.z), VI_VERSION (x.y.z.w), APP_EXE (the
; sentry-studio.exe to install), APP_DIR (the folder with LICENSE.txt and
; THIRD-PARTY-NOTICES.txt), OUT_FILE, ICON, and optionally
; UNINSTALLER_CAPTURE (copy the uninstaller there, to be signed) or
; UNINSTALLER_SIGNED (embed this signed copy of it instead).

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "VERSION is not defined: build with tools/package-windows.sh"
!endif
!ifndef VI_VERSION
  !error "VI_VERSION is not defined: build with tools/package-windows.sh"
!endif
!ifndef APP_EXE
  !error "APP_EXE is not defined: build with tools/package-windows.sh"
!endif
!ifndef APP_DIR
  !error "APP_DIR is not defined: build with tools/package-windows.sh"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is not defined: build with tools/package-windows.sh"
!endif
!ifndef ICON
  !error "ICON is not defined: build with tools/package-windows.sh"
!endif

!define PRODUCT_NAME "Sentry Studio"
!define PUBLISHER "Sentry-Six"
!define DESCRIPTION "Sentry Studio - Tesla Dashcam Viewer"
; electron-builder names the registry keys after the app GUID it derives from
; the app ID (com.sentry-six.revamped): a version 5 UUID in the namespace
; 50e065bc-3134-11e6-9bab-38c9862bdaf3.
!define APP_GUID "cf7c37f6-3080-5f6d-a7fd-79b75b0fa971"
!define INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define APP_EXE_NAME "sentry-studio.exe"
!define UNINSTALL_FILENAME "Uninstall ${PRODUCT_NAME}.exe"
; Electron Studio's executable, and its name before the rename.
!define ELECTRON_EXE_NAME "${PRODUCT_NAME}.exe"
!define OLD_ELECTRON_EXE_NAME "Sentry-Studio.exe"
; electron-updater's download cache (%LOCALAPPDATA%\<package name>-updater).
!define ELECTRON_UPDATER_CACHE "sentry-six-revamped-updater"
!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!include WinVer.nsh

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
BrandingText "${PRODUCT_NAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

; Signing the uninstaller: NSIS writes it into the installer, so a first build
; copies it out to be signed and the release build embeds the signed copy.
!ifdef UNINSTALLER_CAPTURE
  !uninstfinalize 'cp "%1" "${UNINSTALLER_CAPTURE}"'
!endif
!ifdef UNINSTALLER_SIGNED
  !uninstfinalize 'cp "${UNINSTALLER_SIGNED}" "%1"'
!endif

Var isUpdated
Var forceRun
Var keepShortcuts
; 1 when a copy (Electron Studio or this app) is already installed for this user
Var hadInstall

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING

!define MUI_PAGE_CUSTOMFUNCTION_PRE directoryPagePre
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPagePre
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE finishPagePre
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION launchApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VI_VERSION}"
VIFileVersion "${VI_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${DESCRIPTION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "Copyright (c) 2025-2026 Chad and Scott Vandereems"

!macro readCommandLine
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $isUpdated 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $forceRun 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--keep-shortcuts" $R1
  ${IfNot} ${Errors}
    StrCpy $keepShortcuts 1
  ${EndIf}
  ClearErrors
!macroend

; Closes Sentry Studio (this app and Electron Studio) without asking, as
; Electron Studio's installer did. No /t: the updating app started this
; installer, which would count as its child.
!macro closeAppsBody
  ${If} $isUpdated == 1
    ; The app that started the update is quitting by itself.
    Sleep 1500
  ${EndIf}
  nsExec::Exec 'taskkill /f /im "${APP_EXE_NAME}"'
  Pop $0
  nsExec::Exec 'taskkill /f /im "${ELECTRON_EXE_NAME}"'
  Pop $0
  nsExec::Exec 'taskkill /f /im "${OLD_ELECTRON_EXE_NAME}"'
  Pop $0
  nsExec::Exec 'taskkill /f /im "sentry-studio-helper.exe"'
  Pop $0
  Sleep 500
!macroend

Function closeApps
  !insertmacro closeAppsBody
FunctionEnd

Function un.closeApps
  !insertmacro closeAppsBody
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} needs 64-bit Windows 10 or 11." /SD IDOK
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext current

  ; One installer at a time.
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "${APP_GUID}-installer") p .r1 ?e'
  Pop $R0
  ${If} $R0 = 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "The ${PRODUCT_NAME} installer is already running." /SD IDOK
    Quit
  ${EndIf}

  !insertmacro readCommandLine

  ReadRegStr $R2 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $R3 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; Some electron-builder versions kept the closing quote of a quoted /D=.
  StrCpy $R4 $R3 1 -1
  ${If} $R4 == '"'
    StrCpy $R3 $R3 -1
  ${EndIf}
  ${If} $R2 != ""
  ${OrIf} $R3 != ""
    StrCpy $hadInstall 1
  ${EndIf}

  ; The install folder, as electron-builder chooses it: /D=, else the
  ; installed copy's folder, else UserProgramFiles\Sentry Studio
  ; (normally %LOCALAPPDATA%\Programs\Sentry Studio).
  ${If} $INSTDIR == ""
    ${If} $R3 != ""
      StrCpy $INSTDIR $R3
    ${Else}
      StrCpy $0 "$LOCALAPPDATA\Programs"
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2) i .r1'
      ${If} $1 == 0
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN}) p'
      ${EndIf}
      ${If} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${EndIf}
      StrCpy $INSTDIR "$0\${PRODUCT_NAME}"
    ${EndIf}
  ${EndIf}
FunctionEnd

; An update, or a reinstall over an installed copy, keeps its folder.
Function directoryPagePre
  ${If} $isUpdated == 1
  ${OrIf} $hadInstall == 1
    Abort
  ${EndIf}
FunctionEnd

; A folder picked by hand gets its own "Sentry Studio" subfolder, as with
; electron-builder.
Function instFilesPagePre
  ${If} $hadInstall != 1
    ${GetFileName} "$INSTDIR" $0
    ${If} $0 != "${PRODUCT_NAME}"
      StrCpy $INSTDIR "$INSTDIR\${PRODUCT_NAME}"
    ${EndIf}
  ${EndIf}
FunctionEnd

; Nothing to finish after an update, or when the app was started already.
Function finishPagePre
  ${If} $isUpdated == 1
  ${OrIf} $forceRun == 1
    Abort
  ${EndIf}
FunctionEnd

Function launchApp
  SetOutPath "$INSTDIR"
  ${If} $isUpdated == 1
    Exec '"$INSTDIR\${APP_EXE_NAME}" --updated'
  ${Else}
    Exec '"$INSTDIR\${APP_EXE_NAME}"'
  ${EndIf}
FunctionEnd

; Electron Studio's files (Electron 45 and electron-builder 26), when it was
; installed in this folder. Only these names: the folder may be one the user
; picked.
Function removeElectronFiles
  ${IfNot} ${FileExists} "$INSTDIR\${ELECTRON_EXE_NAME}"
  ${AndIfNot} ${FileExists} "$INSTDIR\${OLD_ELECTRON_EXE_NAME}"
  ${AndIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
    Return
  ${EndIf}
  DetailPrint "Removing the earlier version's files..."
  StrCpy $R1 0
  ${Do}
    Delete "$INSTDIR\${ELECTRON_EXE_NAME}"
    Delete "$INSTDIR\${OLD_ELECTRON_EXE_NAME}"
    Delete "$INSTDIR\Uninstall Sentry-Studio.exe"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    Delete "$INSTDIR\uninstallerIcon.ico"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\d3dcompiler_47.dll"
    Delete "$INSTDIR\dxcompiler.dll"
    Delete "$INSTDIR\dxil.dll"
    Delete "$INSTDIR\electron_wer.dll"
    Delete "$INSTDIR\ffmpeg.dll"
    Delete "$INSTDIR\libEGL.dll"
    Delete "$INSTDIR\libGLESv2.dll"
    Delete "$INSTDIR\vk_swiftshader.dll"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\vulkan-1.dll"
    Delete "$INSTDIR\icudtl.dat"
    Delete "$INSTDIR\snapshot_blob.bin"
    Delete "$INSTDIR\v8_context_snapshot.bin"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\version"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\swiftshader"
    ${IfNot} ${FileExists} "$INSTDIR\${ELECTRON_EXE_NAME}"
    ${AndIfNot} ${FileExists} "$INSTDIR\resources\*.*"
      ${ExitDo}
    ${EndIf}
    ; Still in use (a helper process): wait and try again, then give up on
    ; the leftovers, which no longer do anything.
    IntOp $R1 $R1 + 1
    ${If} $R1 >= 5
      DetailPrint "Some of the earlier version's files are in use and were left in $INSTDIR"
      ${ExitDo}
    ${EndIf}
    Sleep 1000
    Call closeApps
  ${Loop}
FunctionEnd

; Electron Studio's assisted installer could also install for all users
; (Program Files, HKLM). That copy is removed with its own uninstaller, which
; needs administrator rights, so Windows asks for them.
Function removeAllUsersElectron
  ReadRegStr $R4 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R4 == ""
    Return
  ${EndIf}
  ; "C:\Program Files\Sentry Studio\Uninstall Sentry Studio.exe" /allusers
  StrCpy $R5 $R4 1
  ${If} $R5 == '"'
    StrCpy $R4 $R4 "" 1
    StrCpy $R7 0
    ${Do}
      StrCpy $R8 $R4 1 $R7
      ${If} $R8 == '"'
      ${OrIf} $R8 == ""
        ${ExitDo}
      ${EndIf}
      IntOp $R7 $R7 + 1
    ${Loop}
    StrCpy $R4 $R4 $R7
  ${EndIf}
  ${IfNot} ${FileExists} "$R4"
    Return
  ${EndIf}
  ${GetParent} "$R4" $R5
  ReadRegStr $R6 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R6 != ""
    StrCpy $R5 $R6
  ${EndIf}
  DetailPrint "Removing the earlier version installed for all users..."
  InitPluginsDir
  CopyFiles /SILENT "$R4" "$PLUGINSDIR\old-uninstaller.exe"
  ; electron-builder's arguments for an old version's uninstaller.
  ExecShellWait "runas" "$PLUGINSDIR\old-uninstaller.exe" '/S /KEEP_APP_DATA /allusers --updated _?=$R5' SW_HIDE
  ClearErrors
FunctionEnd

Function createShortcut
  ; $0: the shortcut
  CreateShortCut "$0" "$INSTDIR\${APP_EXE_NAME}" "" "$INSTDIR\${APP_EXE_NAME}" 0 SW_SHOWNORMAL "" "${DESCRIPTION}"
  ClearErrors
FunctionEnd

Section "-Install"
  ${If} $isUpdated == 1
    SetAutoClose true
  ${EndIf}
  SetOutPath "$INSTDIR"

  Call closeApps
  Call removeElectronFiles

  ; A copy that is still running can't be overwritten but can be renamed:
  ; it is moved aside and deleted by the next install or the uninstaller.
  Delete "$INSTDIR\${APP_EXE_NAME}.old"
  Delete "$INSTDIR\${APP_EXE_NAME}"
  ${If} ${FileExists} "$INSTDIR\${APP_EXE_NAME}"
    Rename "$INSTDIR\${APP_EXE_NAME}" "$INSTDIR\${APP_EXE_NAME}.old"
  ${EndIf}
  File "/oname=${APP_EXE_NAME}" "${APP_EXE}"
  File "${APP_DIR}/LICENSE.txt"
  File "${APP_DIR}/THIRD-PARTY-NOTICES.txt"
  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"

  ; The registry values electron-builder writes for a per-user install.
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayName "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser'
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser /S'
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayIcon "$INSTDIR\${APP_EXE_NAME},0"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" Publisher "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" Comments "${DESCRIPTION}"
  WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoModify 1
  WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" NoRepair 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_REGISTRY_KEY}" EstimatedSize "$0"

  ; Shortcuts. The Start menu one is always (re)made; the desktop one on a
  ; first install, and on an update only if the user kept it. Both replace
  ; Electron Studio's, which have the same names. A taskbar pin of it is
  ; pointed at this app too.
  StrCpy $0 "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Call createShortcut
  ${If} $hadInstall != 1
  ${OrIf} ${FileExists} "$DESKTOP\${PRODUCT_NAME}.lnk"
    StrCpy $0 "$DESKTOP\${PRODUCT_NAME}.lnk"
    Call createShortcut
  ${EndIf}
  StrCpy $0 "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCT_NAME}.lnk"
  ${If} ${FileExists} "$0"
    Call createShortcut
  ${EndIf}
  ; Builds from before the rename to "Sentry Studio".
  Delete "$SMPROGRAMS\Sentry-Studio.lnk"
  Delete "$DESKTOP\Sentry-Studio.lnk"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; electron-builder's copy of Electron Studio's installer (for its
  ; differential updates), which nothing uses any more.
  Delete "$LOCALAPPDATA\${ELECTRON_UPDATER_CACHE}\installer.exe"

  Call removeAllUsersElectron

  ${If} $forceRun == 1
    Call launchApp
  ${EndIf}
SectionEnd

Function un.onInit
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
  SetShellVarContext current
  !insertmacro readCommandLine
FunctionEnd

Section "Uninstall"
  Call un.closeApps
  Delete "$INSTDIR\${APP_EXE_NAME}"
  Delete "$INSTDIR\${APP_EXE_NAME}.old"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  ; Only if it is empty now: the folder may hold the user's own files.
  RMDir "$INSTDIR"

  ${If} $keepShortcuts != 1
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  ${If} $isUpdated != 1
    RMDir /r "$LOCALAPPDATA\${ELECTRON_UPDATER_CACHE}"
  ${EndIf}

  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
SectionEnd
