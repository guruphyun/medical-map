@echo off
chcp 65001 > nul
echo 건강검진기관 지도를 시작합니다...
start http://localhost:8080
python -m http.server 8080
pause
