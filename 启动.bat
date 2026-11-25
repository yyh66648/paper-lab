@echo off
cd /d "%~dp0"
python run.py
if errorlevel 1 (
  echo.
  echo 没有找到 python。请安装 Python 3.12，或用完整路径运行 run.py。
  pause
)
