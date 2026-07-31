import type { EditorGateway } from './EditorGateway';
import type { ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';

/**
 * Serializes every call through an inner gateway: at most one request in
 * flight at a time, applied in call order.
 *
 * Why: the backend keeps one draft per score id with a linear undo/redo
 * journal. Two edit requests in flight at once (e.g. a fast double-click, or
 * `load()` racing an in-flight `apply()`) can land out of order or read a
 * stale view. Queuing removes that at the source instead of relying on
 * server-side locking to sort it out. A failed call still lets the queue
 * drain — one rejected edit must not wedge every edit after it.
 */
export class QueuedGateway implements EditorGateway {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly inner: EditorGateway) {}

  load(scoreId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.load(scoreId));
  }

  apply(scoreId: string, command: Command): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.apply(scoreId, command));
  }

  undo(scoreId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.undo(scoreId));
  }

  redo(scoreId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.redo(scoreId));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op);
    // Always resolves, regardless of whether `op` succeeded — so one failed
    // call still lets the next queued call run. The caller still sees the
    // real result/error through `result`, returned below untouched.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
