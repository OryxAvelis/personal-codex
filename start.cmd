@echo off
title Personal Codex
cd /d "%~dp0"
node launcher.mjs
if errorlevel 1 (
  echo.
  echo Personal Codex could not start.
  pause
)
