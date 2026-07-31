import type { EditorGateway } from './EditorGateway';
import type { ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';
import { fromView, type ScoreView } from '@/core/model/fromView';

// Same-origin in dev via the Vite proxy (see vite.config.ts) -> the backend on :8000.
const API_BASE = '/api';

/** Talks to the backend edit endpoints (`/scores/{id}/edit/...`) and maps the
 *  render view into the client model. */
export class HttpGateway implements EditorGateway {
  private editUrl(scoreId: string): string {
    return `${API_BASE}/scores/${encodeURIComponent(scoreId)}/edit`;
  }

  load(scoreId: string): Promise<ScoreDocument> {
    return this.asDocument(scoreId, fetch(`${this.editUrl(scoreId)}/document`));
  }

  apply(scoreId: string, command: Command): Promise<ScoreDocument> {
    const base = this.editUrl(scoreId);
    switch (command.type) {
      case 'insertNote':
        return this.asDocument(
          scoreId,
          fetch(`${base}/notes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              voice_id: command.voiceId,
              staff_id: command.staffId,
              measure_id: command.measureId,
              position: command.position,
              written_value: command.writtenValue,
              staff_step: command.staffStep,
              accidental: command.accidental ?? 'none',
              fingering: 0,
            }),
          }),
        );
      case 'deleteBatch':
        // mixed multi-select: whole carriers + individual notes, ONE gesture / one undo entry.
        // Flat `entity_ids` — the backend resolves + classifies each id (note vs carrier) itself.
        return this.asDocument(
          scoreId,
          fetch(`${base}/batch-delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entity_ids: command.entityIds }),
          }),
        );
    }
  }

  undo(scoreId: string): Promise<ScoreDocument> {
    return this.asDocument(scoreId, fetch(`${this.editUrl(scoreId)}/undo`, { method: 'POST' }));
  }

  redo(scoreId: string): Promise<ScoreDocument> {
    return this.asDocument(scoreId, fetch(`${this.editUrl(scoreId)}/redo`, { method: 'POST' }));
  }

  private async asDocument(scoreId: string, pending: Promise<Response>): Promise<ScoreDocument> {
    const res = await pending;
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const detail =
        body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
      throw new Error(detail ?? `Request failed (${res.status})`);
    }
    return fromView((await res.json()) as ScoreView, scoreId);
  }
}
