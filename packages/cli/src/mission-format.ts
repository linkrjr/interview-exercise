import type { CrewMission, Mission, MissionSummary } from '@mc/contracts';
import { table } from './io.js';

type Listed = MissionSummary | CrewMission;

const isStaff = (m: Listed): m is MissionSummary => 'version' in m;

/** A list of missions as a table; Crew get the reduced shape, with the acknowledgement. */
export function missionTable(items: Listed[]): string {
  if (items.length > 0 && !isStaff(items[0]!)) {
    return table(
      ['ID', 'NAME', 'STATUS', 'START', 'END', 'ACKNOWLEDGED'],
      (items as CrewMission[]).map((m) => [
        m.id,
        m.name,
        m.status,
        m.startDate,
        m.endDate,
        m.assignment.acknowledgedAt ? 'yes' : 'no',
      ]),
    );
  }
  return table(
    ['ID', 'NAME', 'STATUS', 'START', 'END', 'LEAD', 'VERSION'],
    (items as MissionSummary[]).map((m) => [
      m.id,
      m.name,
      m.status,
      m.startDate,
      m.endDate,
      m.leadName ?? m.leadId,
      String(m.version),
    ]),
  );
}

/** One mission in full, for Directors and Leads. */
export function missionText(m: Mission): string {
  const lines = [
    `${m.name}  [${m.id}]`,
    `Status: ${m.status}   Version: ${m.version}   Lead: ${m.leadName ?? m.leadId}`,
    `Dates: ${m.startDate} to ${m.endDate}`,
  ];
  if (m.description) lines.push(m.description);
  lines.push('Requirements:');
  lines.push(
    ...(m.requirements.length
      ? m.requirements.map((r) => `  ${r.skillName}  level ${r.minLevel}+  x${r.count}`)
      : ['  (none)']),
  );
  lines.push('Crew:');
  lines.push(
    ...(m.crew.length
      ? m.crew.map(
          (c) =>
            `  ${c.name ?? '(no name)'} <${c.email}>  [${c.crewMemberId}]${c.acknowledgedAt ? `  acknowledged ${c.acknowledgedAt}` : ''}`,
        )
      : ['  (none)']),
  );
  if (m.crewValidation) {
    const v = m.crewValidation;
    lines.push(v.valid ? 'Crew check: ready to submit' : 'Crew check: NOT ready to submit');
    for (const i of v.assignmentIssues) lines.push(`  - ${i.crewMemberId} is ${i.code}`);
    for (const u of v.unmetRequirements)
      lines.push(
        `  - requirement ${u.skillId} (level ${u.minLevel}+): needs ${u.required}, has ${u.met}`,
      );
  }
  if (m.decisions.length) {
    lines.push('Decisions:');
    for (const d of m.decisions)
      lines.push(`  ${d.decidedAt}  ${d.decision}${d.comment ? `: ${d.comment}` : ''}`);
  }
  lines.push(`You can: ${m.allowedActions.length ? m.allowedActions.join(', ') : '(nothing)'}`);
  return lines.join('\n');
}

/** One mission as a Crew Member sees it. */
export function crewMissionText(m: CrewMission): string {
  return [
    `${m.name}  [${m.id}]`,
    `Status: ${m.status}`,
    `Dates: ${m.startDate} to ${m.endDate}`,
    ...(m.description ? [m.description] : []),
    `Your assignment: ${m.assignment.id}${m.assignment.acknowledgedAt ? `  (acknowledged ${m.assignment.acknowledgedAt})` : '  (not acknowledged yet)'}`,
  ].join('\n');
}
