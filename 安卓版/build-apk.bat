@echo off
rem ============================================================
rem  一键编译安卓版并复制 APK 到项目根目录
rem  用法：双击本文件，或命令行执行 build-apk.bat
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 1) JDK：优先用 Android Studio 自带的 JBR
if not defined JAVA_HOME (
  if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" (
    set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
  )
)
echo [1/3] JAVA_HOME = %JAVA_HOME%

rem 2) 找 Gradle：优先 wrapper，其次 ~/.gradle 缓存里的发行版
set "GRADLE="
if exist "gradlew.bat" (
  set "GRADLE=gradlew.bat"
) else (
  for /f "delims=" %%i in ('dir /b /s "%USERPROFILE%\.gradle\wrapper\dists\gradle-*-bin\*\gradle-*\bin\gradle.bat" 2^>nul') do (
    if not defined GRADLE set "GRADLE=%%i"
  )
)
if not defined GRADLE (
  echo [x] 没找到 gradle。请先在 Android Studio 里同步一次工程，或安装 Gradle。
  pause
  exit /b 1
)
echo [2/3] Gradle = %GRADLE%

rem 3) 编译并复制到项目根目录
call "%GRADLE%" assembleDebug --console=plain
if errorlevel 1 (
  echo [x] 编译失败，请看上面的错误信息
  pause
  exit /b 1
)

set "APK=app\build\outputs\apk\debug\app-debug.apk"
if exist "%APK%" (
  copy /y "%APK%" "..\苍穹对决.apk" >nul
  echo.
  echo [3/3] 完成！APK 已复制到： %~dp0..\苍穹对决.apk
) else (
  echo [x] 没找到 APK：%APK%
)
pause
