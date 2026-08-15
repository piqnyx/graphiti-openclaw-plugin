# TODO / Wishlist

Здесь только **будущие хотелки и отложенные улучшения**.

Текущее поведение и ближайший активный этап находятся в [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Выполненные работы сюда не возвращать. Историю выполненного хранит Git и `CHANGELOG.md`.

## Надёжность и durability

- Crash-durable pre-MCP spool для active buffers, transcript-delta snapshots и unsent FIFO entries.
- Bounded backlog policy без silent data loss.
- Byte-aware request bounds и явная стратегия split/reject для oversized batch.
- Продуманная safe-shutdown policy: flush, spool или осознанно ephemeral state.
- Отдельная диагностика/метрики размера очереди и возраста oldest pending batch.

## Recall hardening после завершения текущего recall phase

- Bounded per-agent cooldown/backoff для временно недоступного recall backend.
- Query enrichment последними conversation messages, только если тесты покажут недостаточность одного current prompt.
- Настраиваемые quality thresholds/rerank policy, если реальная выдача потребует этого.
- Опциональная диагностика provenance recalled facts без раскрытия лишнего content в обычных логах.

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
- arbitrary `user|assistant` sequences;
- `bufferLimit` как количество сообщений без требования чётности;
- user-only timeout flush;
- per-session Saga + per-agent FIFO;
- caller UUID и stable retry UUID;
- `get_saga` restart recovery;
- `get_queue_status` и backend blocked detection;
- errors-only plugin session/UI status;
- raw Graphiti/OpenViking context stripping;
- read-only Falkor Saga validator;
- directed `NEXT_EPISODE` chronology.
