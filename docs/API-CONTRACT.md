# API университетского приложения

JSON — camelCase. Даты — `YYYY-MM-DD`, время события — ISO 8601 с часовым поясом. Недельный день: 1 = понедельник, 7 = воскресенье. Все защищённые запросы используют cookie-сессию; изменения, кроме входа, требуют `X-CSRF-Token` из ответа входа/`auth/me`.

Ошибки: `{error:string,code?:string}`. 401 — нет действующей сессии, 403 — запрет роли/университета, 400 — неверные данные, 409 — конфликт версии/состояния. Клиент после 409 перечитывает запись. Роли действующего продукта: ADMIN и TEACHER.

## Вход и аккаунт

| Метод и путь | Запрос / ответ |
| --- | --- |
| `POST /api/auth/login` | `{email,password,totp?}` → пользователь, университеты, `csrfToken`. Cookie HttpOnly/SameSite; Secure в production. |
| `GET /api/auth/me` | Текущий пользователь, доступные университеты, `csrfToken`. |
| `POST /api/auth/logout` | Завершение текущей сессии. |
| `POST /api/auth/password` | `{currentPassword,newPassword}`; остальные сессии отзываются. |
| `POST /api/auth/mfa/setup` | `{}` → `{secret,uri}` для TOTP. |
| `POST /api/auth/mfa/enable` | `{code}` — проверка владения секретом. |
| `POST /api/auth/mfa/disable` | `{password,code}`. |

Пароль — 10–200 символов, минимум буква и цифра. Сессия действует 12 часов. Вход ограничен по частоте; секреты/пароли не включаются в обычный профиль пользователя.

## База администратора

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/data/:kind?institutionId=…` | Массив карточек. Текущая библиотека использует `groups`, `students`, `subjects`, `rooms`. |
| `POST /api/data/:kind` | Поля карточки + `institutionId`. |
| `PATCH /api/data/:kind/:id` | Изменённые поля карточки. |
| `DELETE /api/data/:kind/:id` | Удаление с проверкой используемых связей. |
| `GET /api/users?institutionId=…` | Аккаунты университета. |
| `POST /api/users` | `{institutionId,name,email,role:'ADMIN'|'TEACHER',password,active,groupIds?}`. |
| `PATCH /api/users/:id` | Изменение профиля/активности/групп; `{password}` задаёт новый пароль. |
| `PATCH /api/institutions/:id` | Название, язык и разрешённые настройки своего университета. |

Карточки: группа `{name,level?,teacherIds?,teacherId?}`; студент `{name,groupId}`; дисциплина `{name,description?}`; аудитория `{name,capacity?,description?}`. У группы может быть несколько активных преподавателей. `teacherId` сохранён для совместимости. Обновление `groupIds` аккаунта меняет только назначения этого преподавателя.

Управление студенческой базой и эталонами разрешено только ADMIN. У TEACHER чтение студентов ограничено назначенными группами; новый интерфейс работает через сводный университетский маршрут ниже.

`POST /api/students/import` — multipart `file` (CSV), `institutionId`, `groupId` → `{created,students}`. До 5000 строк. Разделитель запятая или точка с запятой. Заголовки: `name`/`ФИО` либо `firstName,lastName` (поддерживаются русские названия). Все строки проверяются до транзакционной записи; автоматического устранения дублей имён нет.

## Уроки преподавателя

| Метод и путь | Запрос / результат |
| --- | --- |
| `GET /api/lesson-materials?institutionId=…` | Массив `LessonMaterial`: свои записи для TEACHER, все записи своего университета для ADMIN. |
| `POST /api/lesson-materials` | Multipart: `title`, `subjectId`, `files` (1–12), необязательный `institutionId` → 201 `LessonMaterial`. |
| `GET /api/lesson-materials/:id` | `LessonMaterialDetail`: та же запись и `documents:[{fileId,text}]`. |

`LessonMaterial`: `id,institutionId,teacherId,subjectId,title,status:'stored',files,extractedCharacters,createdAt,updatedAt`. Файл: `{id,name,mime,size,extractedCharacters,url}`; `url` ведёт на защищённый `/api/files/:id`. Список и ответ загрузки не содержат извлечённый текст; он доступен в деталях.

Указываются только название урока (1–300 символов после обрезки пробелов), существующая дисциплина своего университета и документы. Группы, даты и расписание не требуются; загрузка доступна преподавателю без назначенных групп. Автор определяется сессией, его нельзя подменить полем формы.

- PDF/DOCX/TXT/CSV; до 25 МБ на файл, 50 МБ суммарно, 200 000 извлечённых символов на документ и 1 000 000 на урок. TXT/CSV — UTF-8.
- Корректный PDF без текстового слоя сохраняется с `text:''` и `extractedCharacters:0`. OCR не выполняется. Повреждённые документы и пустые TXT/CSV/DOCX отклоняются.
- Исходные байты сохраняются в закрытом `DATA_DIR/uploads`, ссылки/метаданные — в `files`, извлечённый текст — в JSONB `lesson_materials`. Ошибка одного файла отменяет всю загрузку.
- TEACHER читает только собственные записи и исходники; ADMIN — записи своего университета. Ссылка на приватный исходник из старой общей библиотеки не расширяет права другого преподавателя.

`stored` означает сохранение источников. Загрузка не создаёт расписание, семестр или 3D-видео и не запускает генерацию.

## Авторские 2D- и 3D-уроки

`POST /api/generated-lessons` принимает `{institutionId?,title,language,videoMode?,subjectId?,materialIds?,idempotencyKey?,publication?}`. Язык — `ru/kaa/uz`, формат — `2d/3d`, по умолчанию `2d`. Материалы необязательны. Возвращается 202 с сохранённым `GeneratedLesson` или 200 при точном повторе ключа. Изменение параметров с прежним ключом возвращает 409 `IDEMPOTENCY_CONFLICT`.

`videoMode` сохраняется в уроке, каталоге и готовом manifest. Исторические записи без поля читаются как `3d`, без изменения сохранённых файлов и истории. `POST /api/generated-lessons/:id/retry` принимает только `{revision}` и сохраняет исходный формат. Преподаватель получает только собственные источники и задания, администратор — свой университет.

`GET /api/generated-lessons/config` дополнительно сообщает `authoringConfigured`, доступные `videoModes` и `defaultVideoMode:'2d'`. Не настроенный 2D-брокер возвращает 503 `CODEX_2D_WORKER_NOT_CONFIGURED`; подмена формата на 3D не выполняется. После озвучки генерация автоматически продолжается в выбранном формате, без подтверждения голоса. Нормальный авторский конвейер — `drafting → generating → ready`; готовый фильм длится 600 секунд.

Подготовка и рендер каждого формата идут через отдельный брокер и очередь. Общая озвучка сохраняет сериализацию отдельных обращений к Google. Прогресс дополнительно содержит `alignment` и `images` для синхронизации и иллюстраций, затем авторство, проверку и реальные кадры рендера. Проценты и сроки — оценки; 100% только при `ready`.

## Каталог и прежний конвейер 3D-урока

| Метод и путь | Запрос / результат |
| --- | --- |
| `GET /api/lesson-catalog?institutionId=…` | `LessonCatalogItem[]`: включённая производная, готовые фильмы университета и разрешённые черновики. Производная присутствует и при нуле материалов/записей `lessons`. |
| `GET /api/generated-lessons/config?institutionId=…` | `{configured,externalAllowed,scriptModel,voiceModel,voice}` без ключа. |
| `GET /api/generated-lessons?institutionId=…` | `GeneratedLesson[]`: свои записи TEACHER, весь свой университет ADMIN. |
| `POST /api/lesson-materials/:id/draft` | `{title?}` → 202 `GeneratedLesson` в `drafting`; 200 с существующей работой для того же источника. Ошибочный сценарий без глав можно запустить заново. |
| `GET /api/generated-lessons/:id` | Собственный сценарий и состояние; ADMIN — своего университета. |
| `PATCH /api/generated-lessons/:id` | `{revision,title,summary,chapters}` → проверенный черновик `draft`. `drafting/generating/ready` редактировать нельзя. |
| `POST /api/generated-lessons/:id/generate` | `{revision}` → 202 `generating`; подтверждение проверенного сценария и запуск настоящего TTS. Повтор возможен после `failed`. |
| `GET /api/generated-lessons/:id/manifest` | Только для `ready`: `{id,title,summary,duration,chapters,voice:{status:'ready'}}`. Готовый фильм доступен преподавателям своего университета. |
| `GET /api/generated-lessons/:id/audio/:chapterId` | Авторизованный PCM WAV готовой главы; поддерживаются диапазоны, `Cache-Control: private`. |

`LessonCatalogItem`: `{id,lessonId?,title,subjectId,durationMinutes,status,cinemaId?,description?,materialId?,teacherId?,updatedAt?}`. `cinemaId` — `derivative` либо `generated:<32-значный hex id>`. У незавершённой генерации идентификатор каталога уже имеет вид `generated:<id>`, но `cinemaId` отсутствует до готовности. `lessonId` — фактическая запись `lessons`, доступная для расписания после подготовки; встроенный резервный элемент имеет `id:'builtin:derivative'`.

`GeneratedLesson`: `{id,institutionId,teacherId,subjectId,materialId,title,summary,status,revision,chapters,duration,progress,error?,createdAt,updatedAt,approvedAt?,lessonId?}`. Состояния: `drafting → draft → generating → ready`, ошибка — `failed`. `progress:{stage:'script'|'review'|'voice'|'ready'|'failed',completed,total}` отражает сохранённые этапы/главы, а не искусственный процент. Во время озвучки завершённая глава сохраняется сразу. Перезапуск переводит прерванную работу в явную ошибку для ручного повтора; готовые уроки остаются готовыми.

Глава: `{id,title,narration,scene,headline,formula?,labels,values,example?,palette,start,duration,audioUrl?,audioDuration?}`.

- От 2 до 8 глав; уникальные `id` по шаблону `[a-z0-9][a-z0-9-]{0,63}`.
- `title` — 1–200, `summary` — до 1500, `narration` — 10–3000 символов на главу и не более 18 000 суммарно; `headline` — 1–160, `formula` — до 400, `example` — до 800.
- `scene` — только `concept/chart/process/comparison/orbit`; `palette` — `light/dark`. До 8 подписей по 100 символов и до 8 конечных значений от −1 000 000 до 1 000 000. Для `chart` нужны непустые списки подписей/значений одинаковой длины.
- Черновая длительность предварительная. После TTS `audioDuration` определяется по WAV; `duration` включает аудио и паузу, `start` — накопленное начало. Фиксированная десятиминутная длительность не обещается.

Создание требует `settings.allowExternalAI:true` и серверного ключа Google. Иначе возвращаются 403 `EXTERNAL_AI_DISABLED` или 503 `GENERATION_NOT_CONFIGURED`. Для сценария используется только реальный извлечённый текст источника длиной 30–80 000 символов; OCR не выполняется. При нажатии подготовки сценария текст отправляется Google (`gemini-3.8-flash` по умолчанию). После проверки и отдельного подтверждения озвучка отправляется в `gemini-2.5-pro-preview-tts`, голос `Puck`. Модели настраиваются переменными среды. Само сохранение источника и просмотр готового урока внешние запросы не вызывают.

AI возвращает ограниченные данные для пяти пространственных шаблонов. Генерация произвольного исполняемого кода, HTML, новых GLB-моделей или индивидуального фильма уровня авторской производной не выполняется. Оригиналы и незавершённые сценарии остаются приватными; готовая публикация фильма не даёт другим преподавателям доступ к файлам источника. Конфликты версий — 409 `REVISION_CONFLICT`; ошибки провайдера сохраняются безопасным сообщением без ключа и ответа с приватными данными.

## Календарь администратора

| Метод и путь | Запрос / результат |
| --- | --- |
| `GET /api/schedule/events?institutionId=…&from=…&to=…&includeCancelled=true` | Датированные записи; ADMIN своего университета, TEACHER — свои. Границы/включение отменённых необязательны. |
| `POST /api/schedule/events` | ADMIN: `{institutionId?,lessonId,groupId,teacherId,allDay,from,to,weekdays?,startTime?,durationMinutes?,roomId?,subjectId?}` → `{created,skipped}`. |
| `PATCH /api/schedule/events/:id` | ADMIN: `{revision,date?,lessonId?,groupId?,teacherId?,allDay?,startTime?,durationMinutes?,roomId?,subjectId?}` → запись. |
| `DELETE /api/schedule/events/:id?revision=N` | ADMIN: мягкая отмена → запись с `cancelled,cancelledAt,cancelledBy`; исторические пары сохраняются. |

`from/to` включительны, до 366 календарных дней; `weekdays` — выбранные дни 1–7, без поля — все даты периода. Один день/неделя/произвольный период в интерфейсе используют этот маршрут. `lessonId` — разрешённая готовая запись `lessons`, `builtin:derivative` либо готовый `generated:<id>`; неготовый урок отклоняется. Для первого встроенного урока без записи `lessons` сервер создаёт её с существующим предметом университета.

Для обычного времени нужен `startTime:'HH:mm'`; `durationMinutes` 1–720, по умолчанию длительность урока; конец в тот же день. Сервер проверяет университет, активного преподавателя, группу, аудиторию и пересечения времени. Повторная загрузка того же диапазона пропускает точные совпадения (`skipped`), не создавая дублей. `allDay:true` допустим для готового 3D-урока и не блокирует другие временные пары.

Запись содержит `date,startTime,revision` и поля `ScheduleItem`; событие `/api/university` также содержит `scheduleItemId,scheduleRevision`. Изменение/отмена требуют актуальную версию; иначе 409. Активную пару сначала нужно завершить (`ACTIVE_SESSION`); использованный завершённый снимок не меняется. Отменённые записи по умолчанию исключены из текущего расписания, но доступны с `includeCancelled=true`.

## Университет и прежний API семестров

`GET /api/university?institutionId=…&date=YYYY-MM-DD` → `UniversityData`:

```text
date, groups[], students[], subjects[], rooms[], teachers[], semesters[], events[], sessions[]
```

ADMIN получает свой университет; TEACHER — свои семестры/события/пары и назначенные группы. Завершённые собственные пары остаются доступны после переназначения группы. `sessions` относятся к выбранной дате. Дата по умолчанию определяется в часовом поясе университета, стартовое значение — Asia/Tashkent.

Маршруты семестров сохранены для существующих планов и совместимости. Новый интерфейс загрузки преподавателя использует `/api/lesson-materials` и не требует импорта семестра.

| Метод и путь | Запрос / результат |
| --- | --- |
| `POST /api/semesters/import` | Multipart: `files` (до 12), `institutionId,name,subjectId,groupIds` (JSON-массив), `startDate,endDate`, необязательный `timezone`. PDF/DOCX/TXT/CSV → сохранённый `Semester` со статусом `draft`. |
| `GET /api/semesters/:id` | Разрешённый `Semester`. |
| `PATCH /api/semesters/:id` | `{name?,subjectId?,groupIds?,startDate?,endDate?,topics?,schedule?,status?,timezone?}` → `Semester`. |
| `DELETE /api/semesters/:id` | `{ok:true,archived:boolean}`; использованный семестр архивируется. |

`Semester` содержит `id,institutionId,teacherId,name,subjectId,groupIds,startDate,endDate,files,topics,schedule,status,createdAt,updatedAt` и может содержать `timezone`.

- Тема: `{id,title,content,order,documentName?}`; до 500 тем, уникальные id.
- Слот: `{weekday,startTime:'HH:mm',durationMinutes,roomId?}`; 15–360 минут, до 30 слотов. Пара заканчивается в тот же день.
- Документ: `{id,name,mime?,extractedCharacters?}`; до 25 МБ на файл и 50 МБ суммарно.
- `ready` требует тем и хотя бы одного слота. Для прежнего API недостающее расписание задаётся через `PATCH`; PDF без извлекаемого текста отклоняется. OCR и внешняя LLM не вызываются.

`TeachingEvent` формируется из подтверждённого семестра либо датированной записи `schedule`: `id,institutionId,semesterId?,lessonId?,subjectId,groupId,teacherId,roomId?,room?,date,startsAt,endsAt,topic,semesterName?,allDay?,cinemaId?,scheduleItemId?,scheduleRevision?`. Клиент не может подменить событие произвольной темой при старте.

### Просмотр 3D-урока в течение дня

Для готового урока в `lessons` разрешено поле `cinemaId:'derivative'` либо `generated:<32-значный hex id>`. Датированная запись `schedule` с этим `lessonId` может содержать `allDay:true` наряду с обычными `name,groupId,teacherId,startsAt` и необязательными `room,roomId`. Неготовые/неизвестные фильмы отклоняются; `allDay:true` без поддерживаемого 3D-урока возвращает 400 `INVALID_VIEWING_SCHEDULE`.

Дата просмотра определяется из `schedule.startsAt` в часовом поясе университета. Событие содержит `allDay:true` и идентификатор готового фильма, `startsAt` — местные 00:00 этой даты, `endsAt` — местные 00:00 следующей даты. Интервал включает начало и исключает конец; это ровно 24 часа в `Asia/Tashkent`, а в зоне с переводом часов длительность следует календарным границам. Для недели маршрут диапазона создаёт отдельные датированные записи.

Такое событие открывает готовый фильм для просмотра. `POST /api/teaching-sessions` для него возвращает 409 `VIEWING_ONLY`, без создания пары, таймера камеры или посещаемости. Обычные события без `allDay:true` сохраняют заданное время, длительность урока и прежний порядок запуска пары. Права преподавателя и университета действуют для обоих вариантов.

## Проведение пары

| Метод и путь | Запрос / ответ |
| --- | --- |
| `POST /api/teaching-sessions` | `{institutionId,eventId,date}` → `TeachingSession` в `live`. Повторный старт активного события возвращает существующую пару. |
| `GET /api/teaching-sessions/:id` | Разрешённая пара. |
| `POST /api/teaching-sessions/:id/action` | `{action:'pause'|'resume'|'complete',revision}` → обновлённая пара. |
| `PUT /api/teaching-sessions/:id/attendance` | `{revision,attendance:[{studentId,status}]}` → пара с ручными решениями. |
| `POST /api/teaching-sessions/:id/scans` | Метаданные локальной проверки, описанные ниже → обновлённая пара. |

`TeachingSession`: `id,institutionId,eventId,event,teacherId,groupId,state,startedAt,pausedAt?,pausedMs,completedAt?,scanOffsets,scans,attendance,revision`, а также снимок `roster:[{studentId,name}]` для новых пар. Перевод или переименование студента не переписывает этот снимок. Завершённую пару может читать и проверять её исходный преподаватель после смены назначения группы; другой преподаватель доступа не получает.

Статусы отметки: `present`, `late`, `unconfirmed`, `absent`, `excused`. Все студенты начинают с `unconfirmed`; отсутствие — ручное решение. У отметки сохраняются метод, первое/последнее обнаружение, реальное сходство, признак ручной проверки и автор/время изменения. Ручные решения защищены от автоматической перезаписи.

Запрос сканирования:

```text
{
  revision, capturedAt,
  detectedFaces,
  matches: [{studentId,similarity}],
  unknownFaces,
  status: 'completed' | 'failed',
  error?
}
```

Сходство конечно и в диапазоне 0.65–1; студенты должны входить в состав пары и иметь эталон. Проверяются время, отсутствие дублей, соответствие количества лиц и версия. Неуспешная проверка не может содержать подтверждённые совпадения. Кадр аудитории не передаётся. Сервер проверяет метаданные, а не доказывает подлинность изображения или точность модели.

`scanOffsets` планирует пять успешных проверок: 120 секунд и четыре распределённых времени до конца пары. Ошибки сохраняются отдельно и не превращаются в отсутствие; повтор требует доступной камеры. Клиент не должен сохранять произвольные уверенности или успешные результаты без фактического распознавания.

## Аналитика посещаемости

`GET /api/attendance/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&groupId=…&teacherId=…&institutionId=…` → `AttendanceAnalytics`.

`from`/`to` включительны, период не длиннее 366 дней. По умолчанию — последние 14 календарных дней, включая сегодня в часовом поясе университета. `groupId` и `teacherId` необязательны. ADMIN видит свой университет; TEACHER — только занятия со своим `teacherId`, включая завершённую историю после переназначения групп. Запрос другого преподавателя от TEACHER возвращает 403.

Ответ: `{from,to,timezone,totals,days,groups,sessions}`. `sessions` — сохранённые `TeachingSession`, новые сначала. `days` содержит каждую дату периода, включая пустые дни; `groups` — группы с сохранёнными занятиями. Каждый агрегат включает:

```text
sessions, completedSessions, liveSessions, pausedSessions,
present, late, absent, excused, unconfirmed, total,
attendanceRate, confirmationRate
```

У дня есть `date`, у группы — `groupId,name`. Считаются отметки «студент × занятие», а не уникальные студенты или текущий размер группы. Основание даты — сохранённое `session.event.date`; отчёт включает `live`, `paused` и `completed`, показывая их количества отдельно.

- `attendanceRate = 100 × (present + late) / (present + late + absent)`.
- `confirmationRate = 100 × (total − unconfirmed) / total`.
- Проценты округляются до одного знака; при нулевом знаменателе возвращается `null`, а не 0 или 100.

`unconfirmed` и `excused` не входят в знаменатель посещаемости. `unconfirmed` остаётся отдельным статусом и после завершения пары. Аналитика не меняет отметки, состав или исторические имена; детали и ручные исправления доступны через маршруты проведения пары.

## Фото и распознавание

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/face-enrollments?institutionId=…&groupId=…` | Эталоны разрешённой группы; ADMIN может запросить весь свой университет. |
| `POST /api/files` | Multipart `file,institutionId,name?`; загрузка индивидуального фото в защищённое хранилище → `{id,name,mime,size,url}`. |
| `POST /api/face-enrollments/:studentId` | ADMIN: `{descriptor:number[],modelVersion,photoFileId?}` → сохранённый эталон. |
| `DELETE /api/face-enrollments/:studentId` | ADMIN: удаление эталона распознавания. |
| `GET /api/files/:id` | Авторизованная выдача файла своего университета. |

Текущий клиент вычисляет 1024-мерный дескриптор с `modelVersion:'human-v3-face-description-1024'`; все значения конечны, нулевой вектор не принимается. Совместимый 128-мерный формат прежнего движка может приниматься сервером, но текущая камера сопоставляет только свою версию Human. Удаление эталона не является гарантией стирания всех исходных файлов, истории и резервных копий.

Эталонные фото и документы защищены сервером. Веса Human отдаются статически с самого приложения `/models/face/`. Для камеры необходим HTTPS или localhost и разрешение браузера. Отдельного платного AI-ключа для этих сценариев нет.

## Диагностика

`GET /api/health` → `{status:'ok'}`; `GET /api/config` → `{demoEnabled:boolean}`.

`GET /api/operations/status` — только ADMIN → `{backup:{status:'never'|'running'|'success'|'failed',lastAttemptAt?,lastSuccessAt?},serverTime}`. Источник — закрытый серверный файл `OPERATIONS_STATUS_FILE`; пути, технические ошибки, ключи и содержимое копий не выдаются. Попытка `running` старше 30 минут считается ошибкой. Отсутствие настроенного пути — `never`, недоступный/неверный файл — `failed`. В интерфейсе результат виден в настройках; внешние уведомления не отправляются.

Диагностика камеры в настройках ADMIN выполняет проверку моделей/камеры/кадра в браузере. Она использует уже разрешённые эталоны группы, не создаёт `TeachingSession`/отметки и не отправляет кадр аудитории на новый API. Аппаратный пилот в реальной аудитории остаётся отдельной проверкой. Конкретные TypeScript-структуры находятся в `shared/types.ts`.
