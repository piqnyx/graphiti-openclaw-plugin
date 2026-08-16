# TODO / Wishlist

Здесь только **будущие хотелки и отложенные улучшения**.

Текущее поведение и ближайший активный этап находятся в [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Выполненные работы сюда не возвращать. Историю выполненного хранит Git и `CHANGELOG.md`.

## Надёжность и durability

- Bounded backlog policy без silent data loss: spool сейчас растёт вместе с очередью и переписывается целиком на каждое сообщение.
- Byte-aware request bounds и явная стратегия split/reject для oversized batch.
- Отдельная диагностика/метрики размера очереди и возраста oldest pending batch.
- Подтверждение персистентности episode после acceptance, чтобы restart самого MCP-сервера не терял принятый, но необработанный batch.

## Recall hardening после завершения текущего recall phase

- Bounded per-agent cooldown/backoff для временно недоступного recall backend.
- Настраиваемые quality thresholds/rerank policy, только если live-тесты покажут систематически плохую выдачу поверх текущего Graphiti BM25 + vector + RRF search.
- Опциональная диагностика provenance recalled facts без раскрытия лишнего content в обычных логах.
- Более сложная query enrichment/summary strategy только если ограниченная recent-message history окажется недостаточной.

## Agent-visible tools

После стабилизации automatic capture + recall рассмотреть:

- `graphiti_recall`;
- `graphiti_store`;
- `graphiti_forget`;
- `graphiti_status`.

Требования до реализации destructive tools:

- доказанная group isolation;
- fail-closed identity handling;
- запрет модели на произвольное destructive действие без явного пользовательского намерения;
- понятная семантика удаления episode/fact/entity;
- тесты на отсутствие cross-agent deletion.

## Эксплуатация

- Единый operator helper/CLI для health/status/validation/reset операций, если ручных команд станет слишком много.
- Удобный read-only summary вокруг `tools/falkor_validate.py` для нескольких agents.
- Автоматический smoke после обновления Graphiti/plugin, не затрагивающий production data.
- Более удобная визуализация Saga/Episode/Facts в Falkor Browser или отдельном operator view.

## Возможные будущие Graphiti-функции

- Saga summary/communities только после оценки реальной пользы и стоимости.
- Более богатые custom entity/edge types, если default extraction окажется недостаточным.
- Retention/archival policy для многолетней памяти, если граф реально вырастет до размера, где это станет операционной проблемой.

## Не является TODO

Следующее уже реализовано и не должно появляться здесь как незавершённая работа:

- message-delta capture;
- durable spool active buffers, FIFO entries, transcript watermarks и зарезервированной episode identity;
- reconciliation восстановленного batch через `get_saga` вместо слепого повтора;
- `excludeSessionPatterns` для capture и recall;
- arbitrary `user|assistant` sequences;
- `bufferLimit` как количество сообщений без требования чётности;
- user-only timeout flush;
- per-session Saga + per-agent FIFO;
- caller UUID и stable retry UUID;
- `get_saga` restart recovery;
- `get_queue_status` и backend blocked detection;
- errors-only plugin session/UI status;
- raw Graphiti/OpenViking context stripping;
- history-aware bounded recall query;
- bounded Graphiti recall injection;
- opt-in raw `llm_input` diagnostics;
- read-only Falkor Saga validator;
- directed `NEXT_EPISODE` chronology.
