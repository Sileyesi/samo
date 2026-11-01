Samo — плавный браузер на Chromium (CEF 154) с горизонтальными вкладками и глубокой кастомизацией.
Samo is a smooth Chromium (CEF 154) browser with horizontal tabs and deep customization.

## Установка / Install

### Windows (x64)
- **`Samo-…-windows-x64-setup.exe`** — установщик. По умолчанию ставит только для текущего пользователя, права администратора не нужны. Создаёт ярлык в меню «Пуск».
- **`Samo-…-windows-x64-portable.zip`** — портативная версия: распакуйте и запустите `samo.exe`.

> Установщик не подписан, поэтому Windows SmartScreen может предупредить: «Подробнее» → «Выполнить в любом случае».
> The installer is unsigned: in SmartScreen click "More info" → "Run anyway".

### Linux (x86_64)
- **`Samo-…-x86_64.AppImage`** — один файл: `chmod +x Samo-*.AppImage && ./Samo-*.AppImage`.
- **`samo-…-linux-x86_64.tar.gz`** — установка как приложения (ярлык в меню, иконка):
  ```bash
  tar xf samo-*-linux-x86_64.tar.gz && cd samo-*-linux-x86_64 && ./install.sh
  ```
  `./install.sh --uninstall` удаляет. `sudo ./install.sh --system` ставит в `/opt/samo` для всех пользователей.

## Настройка / Customization
`samo://settings`, `~/.config/samo/config.toml` (Windows: `%APPDATA%\Samo\config.toml`), свои темы и `user.css` — см. README.
