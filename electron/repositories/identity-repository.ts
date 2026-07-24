import type { DatabaseSync } from "node:sqlite";
import type {
  Person,
  PersonAppearance,
  SpeakerTrack,
} from "../../src/types";

type Row = Record<string, any>;

export type PersonAppearanceEvidence = PersonAppearance & {
  embedding?: number[];
  embeddingModel?: string;
  embeddingQuality?: number;
};

export type IdentityEvidenceBatch = {
  appearances?: PersonAppearanceEvidence[];
  speakerTracks?: SpeakerTrack[];
  people?: Person[];
};

function toIso(value: unknown): string {
  return new Date(Number(value) || Date.now()).toISOString();
}

function encodeEmbedding(vector?: number[]): Buffer | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (vector.some((value) => !Number.isFinite(value))) return null;
  const values = new Float32Array(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function decodeEmbedding(value: unknown): number[] | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 4 !== 0) {
    return undefined;
  }
  const buffer = Buffer.from(value);
  const values = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(values);
}

function rowToPerson(row: Row): Person {
  return {
    id: row.id,
    displayName: row.display_name || undefined,
    representativeThumbnailUrl: row.representative_thumbnail_url || undefined,
    status: row.status || "auto",
    mergedIntoPersonId: row.merged_into_person_id || undefined,
    appearanceCount: Number(row.appearance_count) || 0,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToAppearance(row: Row): PersonAppearance {
  return {
    id: row.id,
    personId: row.person_id || undefined,
    videoId: row.video_id,
    shotId: row.shot_id || undefined,
    trackId: row.track_id,
    startSec: Number(row.start_sec) || 0,
    endSec: Number(row.end_sec) || 0,
    confidence: Number(row.confidence) || 0,
    identityConfidence: row.identity_confidence == null
      ? undefined
      : Number(row.identity_confidence),
    thumbnailUrl: row.thumbnail_url || undefined,
    source: row.source || "face_track",
    manualLocked: Boolean(row.manual_locked),
    speakingConfidence: row.speaking_confidence == null
      ? undefined
      : Number(row.speaking_confidence),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToSpeakerTrack(row: Row): SpeakerTrack {
  return {
    id: row.id,
    videoId: row.video_id,
    shotId: row.shot_id || undefined,
    speakerId: row.speaker_id,
    personId: row.person_id || undefined,
    startSec: Number(row.start_sec) || 0,
    endSec: Number(row.end_sec) || 0,
    confidence: Number(row.confidence) || 0,
    linkConfidence: row.link_confidence == null ? undefined : Number(row.link_confidence),
    transcriptText: row.transcript_text || undefined,
    manualLocked: Boolean(row.manual_locked),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function migrateIdentitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      representative_thumbnail_url TEXT,
      status TEXT NOT NULL DEFAULT 'auto',
      merged_into_person_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS person_appearances (
      id TEXT PRIMARY KEY,
      person_id TEXT,
      video_id TEXT NOT NULL,
      shot_id TEXT,
      track_id TEXT NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      identity_confidence REAL,
      thumbnail_url TEXT,
      source TEXT NOT NULL DEFAULT 'face_track',
      manual_locked INTEGER NOT NULL DEFAULT 0,
      speaking_confidence REAL,
      embedding_model TEXT,
      embedding_quality REAL,
      face_embedding BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_person_appearances_video_time
      ON person_appearances(video_id, start_sec, end_sec);
    CREATE INDEX IF NOT EXISTS idx_person_appearances_person
      ON person_appearances(person_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_person_appearances_video_track
      ON person_appearances(video_id, track_id, start_sec, end_sec);

    CREATE TABLE IF NOT EXISTS speaker_tracks (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      shot_id TEXT,
      speaker_id TEXT NOT NULL,
      person_id TEXT,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      link_confidence REAL,
      transcript_text TEXT,
      manual_locked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_speaker_tracks_video_time
      ON speaker_tracks(video_id, start_sec, end_sec);
    CREATE INDEX IF NOT EXISTS idx_speaker_tracks_person
      ON speaker_tracks(person_id);

    CREATE TABLE IF NOT EXISTS person_identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      person_id TEXT,
      related_person_id TEXT,
      appearance_id TEXT,
      speaker_track_id TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS person_identity_constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      left_person_id TEXT NOT NULL,
      right_person_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(kind, left_person_id, right_person_id)
    );
  `);
  try {
    db.exec("ALTER TABLE person_appearances ADD COLUMN embedding_quality REAL");
  } catch {
    // 已迁移。
  }
}

export function createIdentityRepository(db: DatabaseSync) {
  migrateIdentitySchema(db);

  const listPeopleStatement = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM person_appearances a WHERE a.person_id = p.id) AS appearance_count
    FROM people p
    ORDER BY
      CASE p.status WHEN 'confirmed' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END,
      p.updated_at DESC,
      p.id
  `);
  const listAppearancesForVideoStatement = db.prepare(`
    SELECT * FROM person_appearances WHERE video_id = ? ORDER BY start_sec, end_sec, id
  `);
  const listAllAppearancesStatement = db.prepare(`
    SELECT * FROM person_appearances ORDER BY video_id, start_sec, end_sec, id
  `);
  const listSpeakersForVideoStatement = db.prepare(`
    SELECT * FROM speaker_tracks WHERE video_id = ? ORDER BY start_sec, end_sec, id
  `);
  const listAllSpeakersStatement = db.prepare(`
    SELECT * FROM speaker_tracks ORDER BY video_id, start_sec, end_sec, id
  `);
  const insertAppearanceStatement = db.prepare(`
    INSERT INTO person_appearances (
      id, person_id, video_id, shot_id, track_id, start_sec, end_sec,
      confidence, identity_confidence, thumbnail_url, source, manual_locked,
      speaking_confidence, embedding_model, embedding_quality,
      face_embedding, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSpeakerStatement = db.prepare(`
    INSERT INTO speaker_tracks (
      id, video_id, shot_id, speaker_id, person_id, start_sec, end_sec,
      confidence, link_confidence, transcript_text, manual_locked, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertPersonStatement = db.prepare(`
    INSERT INTO people (
      id, display_name, representative_thumbnail_url, status,
      merged_into_person_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = CASE
        WHEN people.status = 'confirmed' THEN people.display_name
        ELSE COALESCE(excluded.display_name, people.display_name)
      END,
      representative_thumbnail_url = COALESCE(
        excluded.representative_thumbnail_url,
        people.representative_thumbnail_url
      ),
      status = CASE
        WHEN people.status IN ('confirmed', 'merged') THEN people.status
        ELSE excluded.status
      END,
      merged_into_person_id = CASE
        WHEN people.status = 'merged' THEN people.merged_into_person_id
        ELSE excluded.merged_into_person_id
      END,
      updated_at = excluded.updated_at
  `);

  const writePerson = (person: Person, now: number): void => {
    if (!person.id) throw new Error("人物缺少 id");
    upsertPersonStatement.run(
      person.id,
      person.displayName || null,
      person.representativeThumbnailUrl || null,
      person.status || "auto",
      person.mergedIntoPersonId || null,
      Date.parse(person.createdAt || "") || now,
      now,
    );
  };

  const recordEvent = (
    action: string,
    fields: {
      personId?: string;
      relatedPersonId?: string;
      appearanceId?: string;
      speakerTrackId?: string;
      payload?: unknown;
    },
  ) => {
    db.prepare(`
      INSERT INTO person_identity_events (
        action, person_id, related_person_id, appearance_id,
        speaker_track_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      action,
      fields.personId || null,
      fields.relatedPersonId || null,
      fields.appearanceId || null,
      fields.speakerTrackId || null,
      fields.payload == null ? null : JSON.stringify(fields.payload),
      Date.now(),
    );
  };

  const requireActivePerson = (personId: string): Row => {
    const row = db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as Row | undefined;
    if (!row) throw new Error(`人物不存在: ${personId}`);
    if (row.status === "merged") throw new Error(`人物已合并: ${personId}`);
    return row;
  };

  return {
    listPeople(): Person[] {
      return listPeopleStatement.all().map((row) => rowToPerson(row as Row));
    },

    listAppearances(videoId?: string): PersonAppearance[] {
      const rows = videoId
        ? listAppearancesForVideoStatement.all(videoId)
        : listAllAppearancesStatement.all();
      return rows.map((row) => rowToAppearance(row as Row));
    },

    listSpeakerTracks(videoId?: string): SpeakerTrack[] {
      const rows = videoId
        ? listSpeakersForVideoStatement.all(videoId)
        : listAllSpeakersStatement.all();
      return rows.map((row) => rowToSpeakerTrack(row as Row));
    },

    listAppearanceEvidence(videoId?: string): PersonAppearanceEvidence[] {
      const rows = videoId
        ? listAppearancesForVideoStatement.all(videoId)
        : listAllAppearancesStatement.all();
      return rows.map((rawRow) => {
        const row = rawRow as Row;
        return {
          ...rowToAppearance(row),
          embedding: decodeEmbedding(row.face_embedding),
          embeddingModel: row.embedding_model || undefined,
          embeddingQuality: row.embedding_quality == null
            ? undefined
            : Number(row.embedding_quality),
        };
      });
    },

    listDifferentPersonPairs(): Array<{ leftPersonId: string; rightPersonId: string }> {
      return (db.prepare(`
        SELECT left_person_id, right_person_id
        FROM person_identity_constraints
        WHERE kind = 'different'
        ORDER BY left_person_id, right_person_id
      `).all() as Row[]).map((row) => ({
        leftPersonId: row.left_person_id,
        rightPersonId: row.right_person_id,
      }));
    },

    upsertPeople(people: Person[]): Person[] {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const person of people) {
          writePerson(person, now);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
        throw error;
      }
      return this.listPeople();
    },

    replaceEvidenceForVideo(videoId: string, batch: IdentityEvidenceBatch): void {
      if (!videoId) throw new Error("replaceEvidenceForVideo 需要 videoId");
      const manualAppearanceIds = new Set(
        (db.prepare(`
          SELECT id FROM person_appearances WHERE video_id = ? AND manual_locked = 1
        `).all(videoId) as Row[]).map((row) => String(row.id)),
      );
      const manualSpeakerIds = new Set(
        (db.prepare(`
          SELECT id FROM speaker_tracks WHERE video_id = ? AND manual_locked = 1
        `).all(videoId) as Row[]).map((row) => String(row.id)),
      );
      const now = Date.now();

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const person of batch.people || []) {
          writePerson(person, now);
        }
        if (batch.appearances !== undefined) {
          db.prepare(`
            DELETE FROM person_appearances WHERE video_id = ? AND manual_locked = 0
          `).run(videoId);
        }
        if (batch.speakerTracks !== undefined) {
          db.prepare(`
            DELETE FROM speaker_tracks WHERE video_id = ? AND manual_locked = 0
          `).run(videoId);
        }

        for (const appearance of batch.appearances || []) {
          if (manualAppearanceIds.has(appearance.id)) continue;
          if (
            !appearance.id
            || appearance.videoId !== videoId
            || !appearance.trackId
            || !(appearance.endSec > appearance.startSec)
          ) {
            throw new Error(`人物出镜证据无效: ${appearance.id || "unknown"}`);
          }
          insertAppearanceStatement.run(
            appearance.id,
            appearance.personId || null,
            videoId,
            appearance.shotId || null,
            appearance.trackId,
            appearance.startSec,
            appearance.endSec,
            appearance.confidence,
            appearance.identityConfidence ?? null,
            appearance.thumbnailUrl || null,
            appearance.source || "face_track",
            appearance.manualLocked ? 1 : 0,
            appearance.speakingConfidence ?? null,
            appearance.embeddingModel || null,
            appearance.embeddingQuality ?? null,
            encodeEmbedding(appearance.embedding),
            Date.parse(appearance.createdAt || "") || now,
            now,
          );
        }

        for (const track of batch.speakerTracks || []) {
          if (manualSpeakerIds.has(track.id)) continue;
          if (
            !track.id
            || track.videoId !== videoId
            || !track.speakerId
            || !(track.endSec > track.startSec)
          ) {
            throw new Error(`说话人轨迹无效: ${track.id || "unknown"}`);
          }
          insertSpeakerStatement.run(
            track.id,
            videoId,
            track.shotId || null,
            track.speakerId,
            track.personId || null,
            track.startSec,
            track.endSec,
            track.confidence,
            track.linkConfidence ?? null,
            track.transcriptText || null,
            track.manualLocked ? 1 : 0,
            Date.parse(track.createdAt || "") || now,
            now,
          );
        }
        db.exec(`
          DELETE FROM people
          WHERE status = 'auto'
            AND NOT EXISTS (
              SELECT 1 FROM person_appearances a WHERE a.person_id = people.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM speaker_tracks s WHERE s.person_id = people.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM person_identity_constraints c
              WHERE c.left_person_id = people.id OR c.right_person_id = people.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM person_identity_events e
              WHERE e.person_id = people.id OR e.related_person_id = people.id
            )
        `);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
        throw error;
      }
    },

    renamePerson(personId: string, displayName?: string): Person {
      requireActivePerson(personId);
      const name = String(displayName || "").trim() || null;
      db.prepare(`
        UPDATE people
        SET display_name = ?, status = 'confirmed', updated_at = ?
        WHERE id = ?
      `).run(name, Date.now(), personId);
      recordEvent("rename", { personId, payload: { displayName: name } });
      return rowToPerson(
        db.prepare(`
          SELECT p.*,
            (SELECT COUNT(*) FROM person_appearances a WHERE a.person_id = p.id)
              AS appearance_count
          FROM people p WHERE p.id = ?
        `).get(personId) as Row,
      );
    },

    mergePeople(sourcePersonId: string, targetPersonId: string): void {
      if (sourcePersonId === targetPersonId) throw new Error("不能合并同一个人物");
      requireActivePerson(sourcePersonId);
      requireActivePerson(targetPersonId);
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE person_appearances
          SET person_id = ?, manual_locked = 1, updated_at = ?
          WHERE person_id = ?
        `).run(targetPersonId, now, sourcePersonId);
        db.prepare(`
          UPDATE speaker_tracks
          SET person_id = ?, manual_locked = 1, updated_at = ?
          WHERE person_id = ?
        `).run(targetPersonId, now, sourcePersonId);
        db.prepare(`
          UPDATE people
          SET status = 'merged', merged_into_person_id = ?, updated_at = ?
          WHERE id = ?
        `).run(targetPersonId, now, sourcePersonId);
        db.prepare(`
          UPDATE people SET status = 'confirmed', updated_at = ? WHERE id = ?
        `).run(now, targetPersonId);
        db.prepare(`
          DELETE FROM person_identity_constraints
          WHERE left_person_id = ? OR right_person_id = ?
        `).run(sourcePersonId, sourcePersonId);
        recordEvent("merge", {
          personId: targetPersonId,
          relatedPersonId: sourcePersonId,
        });
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
        throw error;
      }
    },

    splitAppearance(appearanceId: string, person: Person): Person {
      const appearance = db.prepare(`
        SELECT * FROM person_appearances WHERE id = ?
      `).get(appearanceId) as Row | undefined;
      if (!appearance) throw new Error(`人物出镜记录不存在: ${appearanceId}`);
      if (!person.id) throw new Error("拆分人物缺少新 personId");
      const previousPersonId = appearance.person_id || undefined;
      this.upsertPeople([{ ...person, status: "confirmed" }]);
      const now = Date.now();
      db.prepare(`
        UPDATE person_appearances
        SET person_id = ?, identity_confidence = 1, manual_locked = 1, updated_at = ?
        WHERE id = ?
      `).run(person.id, now, appearanceId);
      if (previousPersonId && previousPersonId !== person.id) {
        const [leftPersonId, rightPersonId] = [previousPersonId, person.id].sort();
        db.prepare(`
          INSERT OR IGNORE INTO person_identity_constraints (
            kind, left_person_id, right_person_id, created_at
          ) VALUES ('different', ?, ?, ?)
        `).run(leftPersonId, rightPersonId, now);
      }
      recordEvent("split", {
        personId: person.id,
        relatedPersonId: previousPersonId,
        appearanceId,
      });
      return this.listPeople().find((item) => item.id === person.id)!;
    },

    linkSpeakerTrack(speakerTrackId: string, personId?: string): SpeakerTrack {
      const track = db.prepare("SELECT * FROM speaker_tracks WHERE id = ?")
        .get(speakerTrackId) as Row | undefined;
      if (!track) throw new Error(`说话人轨迹不存在: ${speakerTrackId}`);
      if (personId) requireActivePerson(personId);
      db.prepare(`
        UPDATE speaker_tracks
        SET person_id = ?, link_confidence = ?, manual_locked = 1, updated_at = ?
        WHERE id = ?
      `).run(personId || null, personId ? 1 : null, Date.now(), speakerTrackId);
      recordEvent("link_speaker", { personId, speakerTrackId });
      return rowToSpeakerTrack(
        db.prepare("SELECT * FROM speaker_tracks WHERE id = ?").get(speakerTrackId) as Row,
      );
    },
  };
}
