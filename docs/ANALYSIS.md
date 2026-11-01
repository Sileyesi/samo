# Samo — дизайн-анализ UI (Zen-уровень плавности, горизонтальные вкладки)

Источники: исходники `zen-browser/desktop` (main, `src/zen/**`, `prefs/zen/*.yaml`), Chromium (`chrome/browser/ui/tabs/tab_style.cc`, `ui/layout_constants.cc`, `views/tabs/tab_container.cc`), Firefox (`browser/themes/shared/tabbrowser/tabs.css`), документация Zen; Arc/Vivaldi — по публичному поведению. **[src]** = значение взято прямо из кода; остальное — рекомендации.

---

## 1. Почему Zen ощущается плавным

### 1.1 Анимации: реальные значения из кода Zen
- **Короткие длительности.** Большинство переходов 100–250 мс: `opacity 0.1s`, `transform 0.1s ease`, `scale 0.15s ease-out`, `opacity 0.2s ease-in-out` **[src]**. Скрытые панели: `--zen-hidden-toolbar-transition: 0.15s ease-in-out` **[src]**.
- **Пружины для «больших» движений** (Motion, `type: "spring"`) **[src]**:
  - Glance: `350ms`, `bounce 0.2`; фоновая вкладка → `scale 0.97`.
  - Split view вставка: `spring bounce 0.4, 0.2s`; ресайз/выход `0.1s ease-out`.
  - Compact mode показ/скрытие сайдбара: `spring bounce 0, 0.1s`.
  - Тосты: вход `spring bounce 0.2, 0.5s`, выход `0.1–0.2s, bounce 0`.
- **CSS `linear()` как пружина.** Выезд панели compact mode: `translate 0.25s linear(0, 0.0027 1%, … 0.497 20%, … 1.0057 92%, … 1.0034 100%)` — задемпфированная пружина с перелётом ~0.5% **[src]**. Также `--spring-easing: linear(0, 0.34 12%, 0.7 24%, 0.93 38%, 1.03 55%, 1)` **[src]**.
- **Кривые (по частоте)** **[src]**: `cubic-bezier(0.075,0.82,0.165,1)` (easeOutCirc — фоны/opacity); `(0.2,0.8,0.2,1)` (оверлеи, 350 мс); `(0.19,1,0.22,1)` (easeOutExpo); `(0.22,1,0.36,1)` (Library, 300 мс); `(0.34,1.56,0.64,1)` (easeOutBack, «поп» кнопок 250 мс); `(0.42,0,0,1)` (иконки папок 300 мс).
- **Тактильный отклик:** нажатая вкладка `scale: 0.98` (`--zen-active-tab-scale`) + `rotate: 0.01deg` для GPU-слоя без размытия **[src]**.
- Анимируются только transform/opacity/scale/translate; `visibility` переключается `0s`-transition с задержкой, «чтобы не было main-thread работы на кадр» **[src]**.
- Скругления: `--zen-border-radius: 7px`, кнопки 6px, иконки URL-бара 8px, floating URL-бар 15px, `--zen-squircle-value: 1.3` **[src]**.
- Тень `--zen-big-shadow: rgba(0,0,0,.24) 0 3px 8px` **[src]**; отступ контента от рамки (`content-element-separation`) 8px — страница-«карточка» **[src]**.

### 1.2 Фичи Zen
- **Compact mode** (`Ctrl+Alt+C`). Дефолты **[src]**: скрыть через `1000ms` после ухода курсора; hover-удержание `150ms`; flash `800ms`; курсор может уйти за окно на 200px гор./100px верт. до схлопывания. Mouse tracker нативный (C++).
- **Split view**: до 4 вкладок (гор/верт/сетка: `Ctrl+Alt+H/V/G`, `Ctrl+Alt+U` разъединить); drag вкладки на контент → сплит (задержка 500ms, порог 40%); мин. ширина 7%; зазор 8px **[src]**.
- **Spaces**: свой набор вкладок, иконка, цвет/градиент, контейнер; свайп и `Ctrl+Alt+E/Q`.
- **Glance**: `Alt+клик` → плавающее окно поверх страницы (350ms пружина), можно развернуть во вкладку/сплит **[src]**.
- **Essentials**: до 12 плиток-фавиконок, общих для всех Spaces **[src]**; pinned — внутри Space, помнит исходный URL.
- **Gradient generator**: до 3 точек на круге, гармонии complementary/split-complementary/analogous/triadic, прозрачность и «зерно», `dark-mode-bias 0.3` **[src]**.
- **Mods**: userChrome-CSS + JSON-настройки, применяются без рестарта.
- **URL-бар**: `zen.urlbar.behavior = floating-on-type` **[src]** — при вводе бар встаёт по центру: ширина `min(innerWidth/1.5, 750px)`, строка 62px, шрифт ×1.15, `backdrop-filter: blur(40px)` **[src]**. `Ctrl+T` открывает этот бар вместо новой вкладки (`replace-newtab = true`); ввод хранится 45s (`wait-to-clear`) **[src]**. Есть quick actions.
- Шорткаты: `Ctrl+Shift+C` copy URL, `Ctrl+Alt+Shift+C` как Markdown, `Ctrl+Alt+C` compact, `Alt+B` ширина сайдбара.

## 2. Уроки других браузеров

### Arc
- Command bar (`Ctrl+T`/`Ctrl+L`) = поиск + вкладки + история + команды в одном списке.
- Little Arc / Peek — временное окно для внешних ссылок (≈ Glance).
- Цвет Space красит весь chrome; Boosts (CSS/JS на сайт); авто-архив вкладок через 12ч.
- Урок: одно место ввода для всего, минимум chrome вокруг страницы.

### Vivaldi
- Accent «из активной страницы» (theme-color/фавикон) — тулбар перекрашивается при смене вкладки.
- Редактор тем (фон, передний план, акцент, радиус, прозрачность), расписание тем.
- Tab stacks (двухуровневые/аккордеон/компакт), Tab tiling выделенных вкладок.
- Quick Commands (`F2`) + **Command Chains** (макрос из команд под одним хоткеем/жестом).
- Жесты мыши, перетаскивание кнопок между тулбарами, custom CSS UI.
- Урок: UI на веб-технологиях → CSS-кастомизация «бесплатно».

### Chrome (Refresh 2023) **[src]**
- Вкладка 34px, полоса = 34 + padding 6; location bar 34; кнопки 34; радиус тулбара 8; вкладка: верх 10px, «юбки» 12px.
- Стандартная ширина 232 (+2×12 ≈ 256); pinned = 24 контента + отступы; min неактивной = 16 DIP (только иконка); min активной = иконка/крестик + отступы. Pre-title 8, after-title 4.
- **Freeze ширины при закрытии мышью:** `EnterTabClosingMode` фиксирует `override_available_width_for_tabs_`; каждое закрытие уменьшает её на ширину закрытой вкладки → следующая вкладка подъезжает крестиком под курсор. Выход — уход мыши с полосы или ширины снова «полные».
- Анимация bounds вкладок: 200ms ease-out.
- Группы: 9 цветов (grey, blue, red, yellow, green, pink, purple, cyan, orange), чип, подчёркивание, сворачивание.
- Throbber: «waiting» (против часовой, серый) vs «loading» (по часовой, акцент).

### Firefox Proton **[src: tabs.css]**
- `--tab-min-height` 36 (normal) / 29 (compact) / 41 (touch); `--tab-min-width: 76px`; `--tab-max-width: 225px`.
- Открытие: `min-width 100ms ease-out, max-width 100ms ease-out`.
- Drag: `transform 200ms cubic-bezier(.07,.95,0,1)` — резкий старт, длинный хвост, «магнитное» ощущение.
- «Парящие» pill-вкладки с отступом 4px (стиль, который взял Zen); lock ширины при закрытии (`_lockTabSizing`).

---

## 3. Спецификация Samo: полоса вкладок и chrome
Размеры в DIP; на Wayland fractional scale — привязка к пиксельной сетке.

### 3.1 Раскладка (normal / compact)
| Элемент | normal | compact |
|---|---|---|
| Tab strip | 40 | 34 |
| Вкладка (верт. отступ) | 32 (4) | 28 (3) |
| Toolbar | 44 | 38 |
| URL-поле | 34 | 30 |
| Кнопка | 32×32, иконка 16–18 | 28×28 |
| Отступ контента («карточка») | 0, опция 6–8 | 0 |
- CSD: вкладки в titlebar, кнопки окна справа; свободная drag-зона ≥24px правее «+».
- Single-row (вкладки+URL в одну строку) — позже.

### 3.2 Вкладка
- Ширина: **max 240**, равномерное деление; **min неактивной 44** (фавикон по центру), **min активной 88** (фавикон+крестик). Pinned **40×32**.
- Отступы: inline 10, фавикон 16, gap 8, крестик глиф 12–16 / хит-зона 20 / радиус 6; title обрезается fade-маской 16px.
- Gap между вкладками **4**, padding полосы 6; без разделителей (pill-стиль). Радиусы: вкладка **8**, кнопки 6, URL 10, меню 12, палитра 14.
- Состояния: inactive — фон прозрачный, текст 70%; hover — `--samo-tab-bg-hover` (fg 6–8%), `background 80ms ease-out`, крестик `opacity 100ms`; active — поверхность + тень `0 1px 2px rgba(0,0,0,.12), 0 0 0 1px var(--samo-border)`; pressed — `scale 0.98, 100ms`; multi-selected — акцент 18%.
- Индикатор: по умолчанию «поднятая карточка». Опция `underline`: 2px × (ширина−16), акцент, скользит `transform 220ms cubic-bezier(0.2,0.8,0.2,1)` (scaleX).
- Крестик: всегда на активной; на прочих — по hover; скрыт при ширине <72. Middle-click закрывает; double-click по пустому — новая вкладка.
- Аудио: иконка 16px перед крестиком, клик = mute; на узкой вкладке заменяет фавикон. Состояния: playing / muted / blocked / recording (красная точка).
- Загрузка: спиннер 16px, дуга 270°, stroke 2, 800ms/оборот linear; waiting — серый, против часовой, 1.2s; фавикон fade-in 150ms; опция hide-throbber.
- Hover-превью: задержка 500ms на первую, 0ms на следующие в течение 1s; появление 120ms.

### 3.3 Анимационные токены
```
--samo-ease-standard:   cubic-bezier(0.2, 0.8, 0.2, 1)
--samo-ease-emphasized: cubic-bezier(0.22, 1, 0.36, 1)
--samo-ease-snap:       cubic-bezier(0.07, 0.95, 0, 1)
--samo-ease-exit:       cubic-bezier(0.4, 0, 1, 1)
--samo-ease-back:       cubic-bezier(0.34, 1.56, 0.64, 1)
--samo-ease-spring:     linear(0, 0.34 12%, 0.7 24%, 0.93 38%, 1.03 55%, 1)
--samo-dur-micro 80ms; --samo-dur-fast 120ms; --samo-dur-base 200ms; --samo-dur-slow 300ms; --samo-dur-glance 350ms
```
| Событие | Что | мс | Кривая |
|---|---|---|---|
| Открытие | ширина 0→target; контент opacity + translateY 4→0 | 180 / 120 | standard |
| Закрытие | ширина →0; контент opacity →0 | 160 / 90 | exit→standard |
| Сдвиг соседей | x | 200 | standard |
| Reorder (drag) | transform соседей | 200 | snap |
| Drag-старт | scale 1.02, тень, z | 120 | standard |
| Drop | к слоту | 180 | spring (bounce ≈0.15) |
| Pin/unpin | ширина + переезд | 220 | emphasized |
| Свернуть группу | ширины | 200 | standard |
| Hover фон | background | 80 | ease-out |
| Смена акцента | цвета в OKLCH | 300 | ease-in-out |
- Detach в новое окно: порог 30px по вертикали.
- Анимировать только transform/opacity; ширину считает свой лейаут-движок с интерполяцией, без reflow на кадр. Прерываемость: ретаргетинг от текущих позиции/скорости, без прыжков.
- Кадры по vsync, 120/144 Гц, UI-бюджет <4ms/кадр.
- Reduced motion: движения → 0, остаются fade ≤100ms.

### 3.4 Закрытие мышью и переполнение
- Freeze: после закрытия мышью `override_width -= closed.width`; разморозка на mouseleave полосы + **300ms**, затем relayout 200ms. Если закрыта крайняя правая — вкладки сдвигаются, чтобы крестик остался под курсором.
- Overflow (все на min): горизонтальный скролл, fade-края 24px, колесо ↕→↔, плавно 150ms, активная автоматически в зоне видимости; pinned и «+» не скроллятся; справа кнопка «список вкладок» с поиском.

### 3.5 Pinned и группы
- Pinned слева, 40px, без крестика; точка 4px снизу при смене title/непрочитанном; «вернуть к закреплённому URL»; опционально pinned = Essentials.
- Группы: 9 цветов Chrome + custom. Чип: высота 24, радиус 6, 12px semibold, фон цвет 20%; линия 2px цвета группы под её вкладками. Свёрнутая = чип со счётчиком; drag чипа тащит группу.

### 3.6 URL-бар / command palette
- В покое: поле 34px, радиус 10, показывает **домен** (полный URL при фокусе); слева безопасность/разрешения; справа copy-URL, закладка.
- `Ctrl+L`: фокус, подсказки dropdown под полем.
- `Ctrl+T`/`Ctrl+K`: **плавающая палитра** по центру: ширина `min(innerWidth/1.5, 720)`, top 20–25% высоты, строка 56, шрифт 16–17px, радиус 14, `blur(32px)`, затемнение 0→20% за 150ms. Вход `opacity 0→1, scale .98→1, translateY −6→0` **180ms emphasized**; выход 120ms exit.
- Подсказки: до 8 строк × 40px; ↑↓/Tab, Enter; Alt+Enter → новая вкладка; Shift+Enter → сплит. Порядок: switch-to-tab → top-hit история/закладки → поисковые подсказки → команды (`>`: compact, split, copy URL, mute, настройки) → `@`-скоупы (`@tabs`, `@history`, `@bookmarks`, движки).
- Первая строка ≤16ms (локальные источники), сеть асинхронно; высота резервируется, без прыжков.
- Esc: 1-й сбрасывает ввод, 2-й закрывает; ввод хранится 45s.

### 3.7 Compact mode
- Тулбар и вкладки скрыты. Hot-zone — верхние **4px** (fullscreen 2px).
- Показ: overlay поверх страницы без reflow, `translateY(-100%)→0` **250ms** Zen-spring `linear()` + тень.
- Скрытие: через **1000ms** после ухода курсора, анимация 150ms ease-in-out; не скрывать при открытом попапе/меню/фокусе URL/drag; допуск за окно 100px.
- Flash 800ms при смене вкладки с клавиатуры / новой вкладке.
- `Ctrl+Alt+C`; режимы hide-all / tabs-only / toolbar-only.

### 3.8 Split view
- MVP-сплит — 2 панели; позже до 4 и сетка. Разделитель 8 (хит-зона 12); двойной клик = 50/50; мин. панель 15%.
- Вход: drag вкладки к краю (зона 25%, задержка 400ms, превью-слот) или `Ctrl+Alt+V/H`. Вставка: spring 200ms bounce 0.3.
- В полосе — одна объединённая вкладка с двумя фавиконками; активная панель — обводка 2px акцентом, 120ms.

### 3.9 Workspaces (опционально)
- Чип слева от вкладок (иконка + цвет); `Ctrl+Alt+1..9`, `Ctrl+Alt+E/Q`. Свои вкладки/pinned, цвет/градиент, опционально контейнер.
- Переход: crossfade + сдвиг 24px по X, 220ms emphasized; свайп двумя пальцами по touchpad.

### 3.10 Цвет из страницы
- Источник: `<meta name="theme-color">` (с `media=prefers-color-scheme`) → manifest `theme_color` → доминирующий цвет фавикона (k-means, без серых <10% насыщенности) → без тинта.
- OKLCH: L `[0.88..0.96]` светлая / `[0.20..0.30]` тёмная, C ≤ 0.10; контраст текста ≥4.5:1; сила 0..1 (default 0.6) через `color-mix(in oklch, …)`.
- Красит tab strip + toolbar; активная вкладка ΔL 0.04.
- Переход 300ms ease-in-out; применять после first visually non-empty paint, не на redirect; кэш по origin.

---

## 4. Модель кастомизации
Слои, каждый перекрывает предыдущий:
1. **`~/.config/samo/config.toml`** — поведение и выбор темы (схема — см. `ARCHITECTURE.md`).
2. **Тема** — CSS-файл, только `:root { --samo-* }` (встроенные + `~/.config/samo/themes/*.css`).
3. **`user.css`** (аналог userChrome) — селекторы по стабильным классам/атрибутам (`.samo-tab[active]`, `[pinned]`, `[audio=playing]`, `:root[data-compact]`). Документированные селекторы = версионируемый публичный API.
4. **Моды** (позже): `mods/<id>/mod.toml` + `mod.css`.
- **Live reload**: inotify, debounce 100ms, без рестарта; ошибка парсинга → тост с файлом:строкой, остаётся последняя рабочая версия.
- Chrome — HTML в отдельном CEF-view (подход Vivaldi), поэтому CSS-кастомизация «бесплатна».

### Переменные темы
- Поверхности: `--samo-bg-window`, `--samo-bg-tabstrip`, `--samo-bg-toolbar`, `--samo-bg-content-frame`, `--samo-bg-popup`, `--samo-bg-palette`, `--samo-backdrop-dim`.
- Вкладки: `--samo-tab-bg`, `-bg-hover`, `-bg-active`, `-bg-selected`, `--samo-tab-fg`, `-fg-active`, `--samo-tab-shadow-active`, `--samo-tab-border-active`, `--samo-tab-indicator`, `--samo-tab-close-bg-hover`.
- Текст/акцент: `--samo-fg`, `--samo-fg-muted`, `--samo-accent`, `--samo-accent-fg`, `--samo-accent-soft`, `--samo-focus-ring`, `--samo-border`, `--samo-border-strong`, `--samo-danger`, `--samo-recording`.
- URL/палитра: `--samo-urlbar-bg`, `-bg-focus`, `-fg`, `--samo-suggestion-bg-hover`, `-bg-selected`, `--samo-palette-blur`.
- Группы: `--samo-group-{grey,blue,red,yellow,green,pink,purple,cyan,orange}`.
- Геометрия: `--samo-tab-height`, `-min-width`, `-max-width`, `-pinned-width`, `-gap`, `-radius`, `--samo-tabstrip-height`, `-padding`, `--samo-toolbar-height`, `--samo-urlbar-height`, `--samo-radius-sm|md|lg|xl` (6/8/12/14), `--samo-content-inset`, `--samo-content-radius`.
- Шрифты: `--samo-font-ui`, `--samo-font-size-ui` (13px), `--samo-font-size-tab` (12.5px), `--samo-font-mono`.
- Движение: `--samo-dur-*`, `--samo-ease-*`, `--samo-tab-press-scale` (0.98).
- Эффекты: `--samo-shadow-sm|md|lg`, `--samo-blur-popup`, `--samo-grain-opacity`.
- Динамические (выставляет браузер, только чтение): `--samo-page-accent`, `--samo-space-color`, `--samo-space-gradient`.

---

## 5. Клавиатурные сочетания (Linux)
**Как в Chrome:** `Ctrl+N` новое окно · `Ctrl+Shift+N` приватное окно · `Ctrl+W`/`Ctrl+F4` закрыть вкладку · `Ctrl+Shift+W` закрыть окно · `Ctrl+Shift+T` вернуть закрытую · `Ctrl+Tab`/`Ctrl+Shift+Tab` и `Ctrl+PgDn/PgUp` следующая/предыдущая · `Ctrl+1..8`, `Ctrl+9` последняя · `Ctrl+Shift+PgUp/PgDn` переместить вкладку · `Ctrl+L`/`Alt+D`/`F6` · `Ctrl+R`/`F5`, `Ctrl+Shift+R` · `Alt+←/→` · `Ctrl+F`, `Ctrl+G` · `Ctrl+D` · `Ctrl+H` · `Ctrl+J` · `Ctrl+±/0` · `F11` · `F12`/`Ctrl+Shift+I` · `Ctrl+U` · `Ctrl+P` · `Ctrl+Shift+Delete` · `Ctrl+Shift+B` · `Shift+Esc` диспетчер задач.

**Дополнительные в Samo:**
| Сочетание | Действие |
|---|---|
| `Ctrl+T` | Command palette (Enter → новая вкладка); опция — классическая новая вкладка |
| `Ctrl+K` / `Ctrl+Shift+P` | Palette в режиме команд (`>`) |
| `Ctrl+Shift+A` | Поиск по открытым вкладкам |
| `Ctrl+Shift+C` | Копировать URL (тост 1.5s) |
| `Ctrl+Alt+Shift+C` | Копировать как Markdown `[title](url)` |
| `Ctrl+Alt+C` | Compact mode |
| `Ctrl+Alt+V` / `Ctrl+Alt+H` / `Ctrl+Alt+U` | Сплит верт. / гор. / разъединить |
| `Ctrl+Alt+←/→` | Фокус панели сплита |
| `Ctrl+Shift+D` | Pin/unpin |
| `Ctrl+M` | Mute/unmute вкладки |
| `Ctrl+Shift+G` | В группу / новая группа |
| `Ctrl+Shift+X` | Дублировать вкладку |
| `Alt+клик` | Glance; `Esc` закрыть, `Ctrl+Enter` → вкладка |
| `Ctrl+Alt+E/Q`, `Ctrl+Alt+1..9` | Spaces |
| `Ctrl+,` | Настройки / config.toml |
| `Ctrl+Alt+R` | Перезагрузить тему и user.css |
- Всё переопределяется в `[keys]`; конфликты показываются при загрузке; chord-сочетания — позже. Сайты не могут перехватить `Ctrl+T/W/N/Tab/L`.

---

## 6. Приоритеты
### MVP v0.1
1. Горизонтальная полоса: open/close/reorder с анимациями из п. 3.3, freeze ширины, overflow-скролл.
2. Состояния вкладки, правила крестика, спиннер, фавикон, аудио-индикатор + mute.
3. Pinned-вкладки (сохраняются в сессии).
4. URL-бар (`Ctrl+L`) + floating palette (`Ctrl+T`): вкладки, история, поиск, базовые команды.
5. Восстановление сессии, `Ctrl+Shift+T`, Chrome-шорткаты + copy URL / compact / mute / pin.
6. Светлая/тёмная тема, CSS-переменные, `config.toml`, `user.css`, live reload.
7. Цвет из страницы (theme-color → фавикон) с OKLCH-нормализацией, отключаемый.
8. Compact mode (hot-zone 4px, показ 250ms, скрытие через 1000ms).
9. Density normal/compact, reduced motion, HiDPI/fractional scale на Wayland, CSD.
10. Drag вкладки в новое окно / между окнами.

### v0.2–0.3
- Группы с цветами и сворачиванием; multi-select.
- Split view (2 панели), объединённая вкладка.
- Glance, hover-превью вкладок.
- Command chains, `@`-скоупы в палитре.
- Редактор тем в UI, градиент-генератор (3 точки, гармонии, зерно).

### Позже
- Workspaces + контейнеры, жесты, Essentials.
- Split до 4 панелей / сетка, tab tiling.
- Моды и каталог, per-site CSS (Boosts).
- Авто-архив вкладок, tab stacks, жесты мыши, single-row, вертикальные вкладки как опция.
