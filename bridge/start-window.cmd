@echo off
cd /d "%~dp0"
start "Wowie bridge" cmd /k node supervisor.js
