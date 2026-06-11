@echo off
:: Lulou Dating — install git hooks (Windows batch wrapper)
::
:: This is the Windows equivalent of scripts/install-hooks.sh.
:: All installation logic lives in scripts/install-hooks.cjs so that
:: both wrappers stay in sync automatically.
::
:: Preferred usage:
::   node scripts/install-hooks.cjs
::
:: Shell wrapper (Unix/macOS only):
::   sh scripts/install-hooks.sh
::
:: Batch wrapper (Windows):
::   scripts\install-hooks.cmd

where node >nul 2>&1
if errorlevel 1 (
    echo   x  node is not in PATH. Please run: node scripts/install-hooks.cjs
    exit /b 1
)

for /f "delims=" %%R in ('git rev-parse --show-toplevel 2^>nul') do set REPO_ROOT=%%R
if "%REPO_ROOT%"=="" set REPO_ROOT=%~dp0..

node "%REPO_ROOT%\scripts\install-hooks.cjs" %*
