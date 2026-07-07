; LURDS ORDER ONE — Custom NSIS Installer Script
;
; Adiciona uma página de senha ANTES da instalação. Sem a senha correta,
; instalação é cancelada (sem retry — evita bug de loop infinito no
; nsDialogs quando combinado com Abort).
;
; Pra TROCAR A SENHA: edita a linha StrCmp $1 abaixo.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var Dialog
Var PasswordInput

; ── Auto-fechar o app antes de instalar ─────────────────────────────────
; O ORDER ONE vive na bandeja e o X só esconde a janela (não encerra), então
; o instalador nunca consegue fechar sozinho e mostrava "Não é possível
; fechar o LURDS ORDER ONE / Repetir". Este gancho do electron-builder roda
; ANTES da checagem padrão: mata o processo à força (/T inclui filhos do
; Electron) e espera o Windows liberar os arquivos.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /T /IM "LURDS ORDER ONE.exe"'
  Sleep 1500
!macroend

; Insere a página antes da página de bem-vindo
!macro customWelcomePage
  Page custom PasswordPageCreate PasswordPageLeave
!macroend

; Página custom de senha
Function PasswordPageCreate
  !insertmacro MUI_HEADER_TEXT "Senha de Instalação" "Digite a senha autorizada pra instalar o LURDS ORDER ONE."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 36u "Este aplicativo é restrito a lojas autorizadas Lurd's Plus Size.$\r$\n$\r$\nDigite a senha fornecida pela matriz:"
  Pop $0

  ${NSD_CreatePassword} 0 42u 100% 14u ""
  Pop $PasswordInput

  ${NSD_CreateLabel} 0 60u 100% 24u "Se errar a senha, a instalação será cancelada. Solicite a senha à matriz e tente novamente."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function PasswordPageLeave
  ${NSD_GetText} $PasswordInput $1

  ; ⚠ SENHA AQUI — troque pra mudar:
  ${If} $1 == "LURDS2026"
    ; Senha correta — continua
    Return
  ${EndIf}

  ; Senha errada → mensagem + cancela instalação
  MessageBox MB_ICONSTOP|MB_OK "Senha incorreta.$\r$\n$\r$\nA instalação será cancelada. Solicite a senha correta à matriz e execute o instalador novamente."
  Quit
FunctionEnd
