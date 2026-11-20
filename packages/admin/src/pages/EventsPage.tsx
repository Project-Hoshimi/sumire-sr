import { EventEditorPage, EventListPage } from './EventEditorPage.tsx';
import type { AdminSessionUser } from '../types.ts';

/** `#/events` lists definitions; `#/events/:id` is the marathon editor. */
export function EventsPage({ id, user }: { id?: string; user: AdminSessionUser }) {
  if (id === undefined) return <EventListPage user={user} />;
  return <EventEditorPage key={id} id={id} user={user} />;
}
