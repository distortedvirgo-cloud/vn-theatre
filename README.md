# VN Theatre for SillyTavern

Визуально-новелльный режим (visual novel) + системные движки для SillyTavern —
порт презентации и механик [RP-проекта pnotisdev/rp](https://github.com/pnotisdev/rp):
полноэкранная VN-сцена, движок отношений с судьёй, интим-стейт, чипы намерений,
AI-подсказки хода и автоматический перевод сообщений через API.

A visual-novel presentation mode and gameplay engines for SillyTavern (ported from
pnotisdev/rp), with per-message auto-translation.

## Возможности

### VN-сцена
- Полноэкранный оверлей: фон сцены (кроссфейд 500 мс), градиентная вуаль,
  диалоговый бокс с blur-подложкой, плашка с именем и чип-аватар персонажа.
- Теги сцены `<<scene: expression=shy, background=cafe, mood=romantic, outfit=linen-dress>>` —
  модель сама управляет сценой; тег прячется и в оверлее, и в чате.
  `expression` — цветокоррекция персонажа, `background` — фон (градиент по хэшу или
  своя картинка из настроек), `mood`/`outfit` — подпись у имени + запоминается движком.
- Лепестки сакуры (canvas), бэклог на 30 сообщений, композер прямо в оверлее
  (можно отвечать, не выходя из VN-режима), комикс-бёрсты для звукоподражаний.

### Движок отношений (per-reply judge)
После каждого ответа модели фоновый LLM-вызов (`generateQuietPrompt`) оценивает ход:
- **7 шкал** (affection/trust/chemistry/comfort/respect/curiosity/tension, −2..+2 за ход),
  накопление 0..100 и **стадии**: near_strangers → acquaintances → warming_up →
  getting_close → close → sweethearts;
- **флаги** (first_date, confession, jealousy, promise, first_kiss, first_intimate,
  moving_in, proposal, married, breakup_risk) → производный commitment
  (none → dating → exclusive → living_together → married);
- **психика персонажа**: mood (20 значений) и need (8 значений), приватные
  intent/desire/fear;
- **планы / убеждения / ожидания** — живые списки (макс 3/5/5), обновляются судьёй
  (add/drop/resolve);
- **факты чата** (lorebook-lite, до 30, с unresolved-статусом);
- масштабирование дельт сложностью: gentle ×0.5 / normal ×1 / harsh ×1.5;
- регенерация не дублирует оценку (guard по id сообщения).

### Интим-стейт и [Scene facts]
- Модель-«датчик» через `intimacyObservation`: вовлечённость, интенсивность,
  снятая одежда (5 слоёв), зоны контакта, завершение стадии.
- Возбуждение 0..100 с бэндами baseline/warming/engaged/edge/over и затуханием
  между сценами.
- Всё это собирается в блок **[Scene facts]** и инъекцией (depth 2) попадает в промпт:
  локация/mood, одежда обоих участников, возбуждение, контакт, планы персонажа,
  открытые вопросы. Модель просится не противоречить фактам.
- Панель состояния позволяет вручную править всё: клики по слоям одежды,
  слайдер-бары, удаление планов, полный сброс.

### Чипы намерений и AI-подсказки
- **Intent chips** (Flirt/Tease/Open up/Reassure/Apologize) — армятся перед отправкой
  (и в оверлее, и над полем ввода), попадают в промпт и в судью как контекст
  («не награждай попытку автоматически»), снимаются после генерации.
- **AI-выборы хода** — после каждого ответа 3 варианта следующего действия
  (кнопки над полем ввода; клик = отправить).

### Перевод
- Кнопка на каждом сообщении, кнопка в оверлее, автоперевод новых ответов.
- Провайдеры: Google (бесплатный gtx, без ключа) и LibreTranslate (URL + ключ).
- Кэш по чату; HTML и scene-теги вычищаются перед отправкой в переводчик.

## Установка

**Через UI SillyTavern:** Extensions → Install extension → вставьте URL этого репозитория.

**Вручную:**
```bash
cd <SillyTavern>/data/<user-handle>/extensions
git clone https://github.com/distortedvirgo-cloud/vn-theatre.git
```

Перезапустите ST. Кнопки появятся в меню расширений (палочка над полем ввода):
**VN Theatre** — VN-режим, **VN State** — панель состояния (работает и без VN-режима).

## Пресеты

В папке `presets/` лежат пресеты автора:

- **DEUS-EX-MACHINA-FF5-NSFW.json** — основной: база DEUS.EX.MACHINA V2.3 + модуль
  「 Conquest & Breaking 」. Рекомендуемые настройки: temperature 0.75, Top P 0.95,
  остальное 1.0/выключено, post-processing «merge consecutive roles», reasoning on
  (medium), Scene Plan on.
- **GLM-FF5-Hybrid.json** — прежний standalone-пресет.

Положите файл в `<SillyTavern>/data/<user-handle>/OpenAI Settings/` или импортируйте
через UI (OpenAI → пресеты → импорт).

## Отладка

`window.__vnt` в консоли браузера: `.state()` — текущее состояние, `.applyJudge(json)`
— применить оценку вручную, `.judgeNow()` / `.choicesNow()` — запуск assist-вызовов,
`.toggleDrawer()` — панель.

## Требования

- SillyTavern ≥ 1.18 (проверено на 1.18.0-pov.2; используется object-API `generateQuietPrompt`)
- Судья и подсказки ходов тратят токены основного провайдера

## License

MIT
