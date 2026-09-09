# VN Theatre for SillyTavern

Визуально-новелльный режим (visual novel) для SillyTavern — перенос презентации из
[RP-проекта pnotisdev/rp](https://github.com/pnotisdev/rp): полноэкранная сцена с фоном,
аватаром персонажа, диалоговым боксом и лепестками сакуры + автоматический перевод
сообщений через API.

A visual-novel presentation mode for SillyTavern (ported from pnotisdev/rp) with
per-message auto-translation.

## Возможности

- **VN-сцена** — полноэкранный оверлей: фон сцены (кроссфейд 500 мс), градиентная
  вуаль, диалоговый бокс с blur-подложкой, плашка с именем и чип-аватар персонажа.
- **Теги сцены `<<scene: ...>>`** — модель сама управляет сценой, завершая ответ тегом:
  ```
  <<scene: expression=shy, background=cafe>>
  ```
  - `expression`: `neutral, happy, sad, angry, shy, love, surprise, sleepy` — меняет
    цветокоррекцию персонажа;
  - `background`: `cafe, classroom, park, bedroom, city, beach, temple, living_room,
    street, school` — детерминированный градиент-плейсхолдер или своя картинка.
  Тег автоматически скрывается и в VN-оверлее, и в обычном чате.
- **Свои фоны** — в настройках: `name=https://...jpg`, по одному в строке. Без
  картинки ключ рендерится градиентом (тот же алгоритм, что в rp: hash → HSL).
- **Спрайт или чип** — крупные картинки (≥256px) показываются на сцене с кроссфейдом,
  маленькие аватарки ST — круглым чипом у плашки имени.
- **Лепестки сакуры** — canvas-анимация, отключается кнопкой в топбаре.
- **Бэклог** — последние 30 сообщений в оверлее, с переводами.
- **Перевод** — кнопка на каждом сообщении чата, кнопка в оверлее, автоперевод новых
  ответов (настраивается). Провайдеры: Google (бесплатный gtx-endpoint, без ключа) и
  LibreTranslate (URL + ключ). Перевод кэшируется по чату.
- **Тайпрайтер** — печатная машинка для обычного текста; сообщения с HTML (VTK и т.п.)
  рендерятся через `messageFormatting` как в чате.

## Установка

**Через UI SillyTavern:** Extensions → Install extension → вставьте URL этого репозитория.

**Вручную:**
```bash
cd <SillyTavern>/data/<user-handle>/extensions
git clone https://github.com/distortedvirgo-cloud/vn-theatre.git
```

Перезапустите ST, включите режим кнопкой **VN Theatre** в меню расширений (палочка
над полем ввода).

## Пресеты

В папке `presets/` лежат пресеты автора:

- **DEUS-EX-MACHINA-FF5-NSFW.json** — основной: база DEUS.EX.MACHINA V2.3 + модуль
  「 Conquest & Breaking 」. Рекомендуемые настройки: temperature 0.75, Top P 0.95,
  остальное 1.0/выключено, post-processing «merge consecutive roles», reasoning on
  (medium), Scene Plan on.
- **GLM-FF5-Hybrid.json** — прежний standalone-пресет.

Положите файл в `<SillyTavern>/data/<user-handle>/OpenAI Settings/` или импортируйте
через UI (OpenAI → пресеты → импорт).

## Требования

- SillyTavern ≥ 1.12 (проверено на 1.18.0)
- Зависимостей нет, всё клиентское

## License

MIT
