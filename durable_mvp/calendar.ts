import {Type} from '@earendil-works/pi-ai';
import {defineTool} from '@earendil-works/pi-durable';
import {addDays, DEFAULT_TIME_ZONE, nowInDefaultZone, range} from './calendar-time.ts';
import type {CalendarEvent, CalendarWriteInput, PersonalStore} from './personal-store.ts';

export type {CalendarEvent};

const output = (value: unknown) => ({output: [{type: 'text' as const, text: JSON.stringify(value)}]});

export function inRange<T extends Pick<CalendarEvent, 'start' | 'end'>>(events: readonly T[], start: unknown, end: unknown) {
  const [a, b] = range(start, end);
  return events.filter(e => Date.parse(e.start) < b && Date.parse(e.end) > a);
}

function requireStore(store: PersonalStore | undefined): PersonalStore {
  if (!store) throw new Error('PersonalStore is not configured');
  return store;
}

export function calendarTools(event: (kind: 'tool') => void, store?: PersonalStore) {
  const write = (updating = false) => defineTool({
    name: updating ? 'update_calendar_event' : 'create_calendar_event',
    description: (updating
      ? 'Update ONE saved event by eventId from list_calendar_events. When moving it with when, preserve its duration unless a new end or duration is specified. Omitted fields retain saved values.'
      : 'Create ONE NEW event with a title and start/end timing. Use explicit offsets for start and end, or use when for the start and provide an end or durationMinutes inside when. Ask for missing creation fields.') +
      ` Call get_current_time before interpreting relative dates and pass a structured when for server-side resolution. Optional IANA timeZone defaults to the saved zone on update or ${DEFAULT_TIME_ZONE} (fixed UTC+8) on creation. On needs_confirmation use the page confirmation button. Only status created or updated means success. confirmationId retries a pending operation; only server-recorded user confirmation authorizes overlap. No recurrence/reminders.`,
    parameters: Type.Object({
      ...(updating ? {eventId: Type.Optional(Type.String())} : {}),
      title: Type.Optional(Type.String({maxLength: 200})),
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
      timeZone: Type.Optional(Type.String()),
      when: Type.Optional(Type.Object({
        day: Type.Optional(Type.String()),
        date: Type.Optional(Type.String()),
        absolute: Type.Optional(Type.String()),
        time: Type.Optional(Type.String()),
        offsetMinutes: Type.Optional(Type.Number()),
        durationMinutes: Type.Optional(Type.Number()),
      })),
      confirmationId: Type.Optional(Type.String()),
    }),
    replay: 'safe',
    execute: async (input, api) => {
      event('tool');
      if (!updating && Object.hasOwn(input, 'eventId')) {
        throw new Error('创建工具不接受 eventId；修改请使用 update_calendar_event');
      }
      return output(requireStore(store).runCalendarWrite({
        updating,
        input: input as CalendarWriteInput,
        conversationId: api.conversationId,
        taskId: api.taskId,
        callId: api.callId,
      }));
    },
  });

  return [
    defineTool({
      name: 'list_calendar_events',
      description: 'Read saved calendar events overlapping an explicit start/end range. Ask for missing dates; never invent results.',
      parameters: Type.Object({start: Type.String(), end: Type.String()}),
      replay: 'safe',
      execute: async ({start, end}) => {
        event('tool');
        return output({events: requireStore(store).listCalendarEvents(start, end)});
      },
    }),
    write(),
    write(true),
    defineTool({
      name: 'delete_calendar_event',
      description: 'Delete ONE saved event by eventId obtained from list_calendar_events. Resolve ambiguous matches with the user first. Only status deleted means success.',
      parameters: Type.Object({eventId: Type.String()}),
      replay: 'safe',
      execute: async ({eventId}, api) => {
        event('tool');
        return output(requireStore(store).deleteCalendarEvent({
          eventId,
          conversationId: api.conversationId,
          taskId: api.taskId,
          callId: api.callId,
        }));
      },
    }),
    defineTool({
      name: 'get_current_time',
      description: 'Return the current instant in the project timezone (fixed UTC+8) together with today, tomorrow, dayAfterTomorrow and the Chinese weekday. Call this before resolving any relative date or time.',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => {
        event('tool');
        const now = nowInDefaultZone();
        const today = now.slice(0, 10);
        const weekday = '日一二三四五六'[new Date(today + 'T00:00:00Z').getUTCDay()];
        return output({
          now,
          timeZone: DEFAULT_TIME_ZONE,
          today,
          tomorrow: addDays(today, 1),
          dayAfterTomorrow: addDays(today, 2),
          weekday: '周' + weekday,
        });
      },
    }),
  ];
}
