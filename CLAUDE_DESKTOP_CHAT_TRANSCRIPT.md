# Mission Control — Design Chat Transcript

This is a record of the conversation in which the Mission Control design document was produced. It covers every user message, every clarifying question with the options offered and the answer given, and Claude's replies. Behind-the-scenes tool work (writing files, rendering previews, publishing) is summarised briefly in *[italics]*.

---

## 1. User — initial request

> write a project design document based on the following information.
> do not assume anything, if anything is ambiguous, ask me.

```markdown
Space organisations need to plan complex missions requiring specific crew capabilities. Crew assignment is currently manual and error-prone — leads spend hours cross-referencing skill profiles, availability calendars, and existing commitments. Multiple organisations will use this platform, each with different crew sizes, skill taxonomies, and approval processes.
Mission Control is a B2B platform that helps organisations manage missions and intelligently assign crew based on skills, availability, and workload. Your task is to design and build its core.
Before implementation, produce the design document you would use to communicate the intended solution to an engineering team and guide an AI coding agent. Submit that document with your implementation and transcripts.
You have broad latitude over the product design, data model, technical architecture, and the form and structure of the design document. We're looking for a solution you'd be comfortable putting in front of a customer.
Minimum scope: A multi-tenant API with roles, a mission lifecycle and approval workflow, crew management with skill profiles, an auto-matching engine, and a CLI through which the primary workflows can be exercised.


The Domain
Mission Control is a multi-tenant B2B platform for space organisations. Here's the world you're building for:
Organisations are your tenants — space agencies, research labs, private companies. All data is strictly scoped to an organisation. Data must never leak across tenants.
Crew Members belong to an organisation. They have skill profiles, availability, and assignment history. How you model skills and proficiency is up to you.
Missions belong to an organisation. They have requirements, timelines, and a lifecycle that includes some form of approval before going active. How you design the lifecycle and its transitions is a design decision we're interested in.
Assignments connect crew to missions. The platform should include an auto-matching engine that intelligently suggests crew for missions based on skills, availability, and constraints. The sophistication of this algorithm is part of what we're evaluating.
Roles
The platform has three user roles with different levels of access:
Directors run the organisation. They manage settings, approve missions, and have broad visibility.
Mission Leads plan and manage missions. They define requirements, run the matcher, and submit missions for approval. They should not be able to approve their own missions.
Crew Members manage their own profiles, availability, and respond to assignments. They have limited visibility into the broader organisation.
```

---

## 2. Claude — clarifying questions

> I'll pin down the open decisions before writing, since you asked me not to assume. This first round covers the foundations. A second round will cover the domain rules: role overlap, per-organisation approval configuration, the skill and proficiency model, the lifecycle states, what the matcher optimises for, and how crew respond to assignments.

### Round 1 — Foundations

**Q1. Which language and framework should the API and CLI be built in?**
- Python + PostgreSQL — FastAPI for the API, Typer for the CLI, SQLAlchemy/Alembic
- **TypeScript + PostgreSQL** — Fastify or NestJS for the API, oclif/commander for the CLI, Prisma or Drizzle ✅
- Go + PostgreSQL — chi/echo for the API, cobra for the CLI, sqlc
- Java/Kotlin + PostgreSQL — Spring Boot for the API, picocli for the CLI

**Q2. How strictly should tenants be isolated at the data layer?**
- **Shared DB + row-level security** — one schema, org_id on every row, enforced by the app and by Postgres RLS as a backstop ✅
- Shared DB, app-enforced only
- Schema per tenant
- Database per tenant

**Q3. How should users authenticate to the API and CLI?**
- **Built-in login + tokens** — email/password login issues short-lived JWTs; CLI stores the token locally ✅
- Personal API tokens only
- External OIDC provider
- Stubbed for now

**Q4. What form should the design document take?**
- Markdown file in the repo
- Claude document
- **Both** — shareable document plus a Markdown copy for the repo ✅

### Round 2 — Domain rules

> Thanks. Now the domain rules.

**Q5. Can one user hold more than one role within an organisation, and who approves a mission a Director creates?**
- Multiple roles, no self-approval
- **Exactly one role per user** — Directors approve only; they never lead missions ✅
- One role, Directors can lead

**Q6. How configurable should each organisation's approval process be?**
- Configurable approver count
- **Single Director approval** — same rule for every org: one Director who isn't the submitter ✅
- Configurable multi-stage chain

**Q7. How should skills and proficiency be modelled?**
- **Org taxonomy + 1–5 levels** — each org defines its skill catalogue; crew hold skills at a numeric level 1–5 ✅
- Org taxonomy + org-named levels
- Categories, levels, certifications

**Q8. What should the auto-matcher optimise for?**
- **Best team, balanced workload** — hard constraints (skills, availability, conflicts) then a weighted score; solves the whole team at once, not seat by seat ✅
- Ranked suggestions per seat
- Both modes

### Round 3 — Lifecycle, assignments and tenancy

> Last round, on lifecycle, assignments and tenancy boundaries.

**Q9. When must the crew be settled relative to approval?**
- **Crew confirmed before submit** — Draft → Crewing → Pending approval → Approved → Active → Completed; Director approves a mission with a known team ✅
- Crew assigned after approval
- Either, per mission

**Q10. How do crew members respond to an assignment?**
- Accept or decline
- **Binding, no response** — Lead assigns; crew member is notified only ✅
- Accept, or decline with reason

**Q11. At what granularity is availability and mission timing tracked?**
- **Whole days (dates only)** ✅
- Timestamps with time zones

**Q12. How are organisations and users created, and can a user belong to more than one organisation?**
- **Platform admin, one org per user** — an operator-level admin creates orgs and their first Director; each user belongs to exactly one org ✅
- Self-serve signup, one org
- Platform admin, multi-org users

### Round 4 — Gaps, including one conflict with the brief

> A few gaps remain. One of them is a conflict between your answer and the brief.

**Q13. The brief says crew members "respond to assignments", but you chose binding assignments with no response. How should these fit together?**
- Binding, can request release
- **Binding, acknowledge only** — crew member acknowledges receipt; no ability to refuse ✅
- Switch to accept/decline

**Q14. What does a mission's crew requirement look like?**
- Named seats
- **Skills + crew size** — e.g. team of 4 must cover Piloting ≥4 ×1 and Medicine ≥3 ×2; one person can cover several ✅
- Seats plus team-wide needs

**Q15. How should "workload" be measured for balancing and limits?**
- Assigned days in a window
- **Count of upcoming missions** — number of approved or active missions a person is on, with an org-set maximum ✅
- Both

**Q16. What happens when a Director rejects a mission, or a mission needs changes after approval?**
- Back to Crewing, re-approve
- Rejection terminal, edits re-approve
- **Back to Crewing, approved locked** — rejected missions return for edits; approved missions can only be cancelled ✅

### Round 5 — Who does what

> Nearly there. A few questions about who does what.

**Q17. How do missions move from Approved to Active to Completed?**
- **Automatic by date** ✅
- Manual by the Lead
- Manual, date-guarded

**Q18. Who decides a crew member's skill levels?**
- Self-declared, Lead/Director verified
- **Self-declared, used as-is** ✅
- Set by Leads/Directors only

**Q19. What can Mission Leads and Crew Members see?**
- **Leads: all; Crew: own only** — Leads see all org missions and crew; crew see only their profile and their approved assignments ✅
- Leads: own; Crew: own only
- Leads: all; Crew: roster too

**Q20. How are crew members notified of assignments?**
- **In-app inbox only** ✅
- Inbox + email
- Inbox + webhooks

### Round 6 — Final details

> Final round, and then I'll write it.

**Q21. How is availability recorded?**
- **Unavailable ranges, crew-owned** — crew are available by default and add date ranges when they are unavailable ✅
- Unavailable ranges, crew or Lead/Director
- Available ranges only

**Q22. Who can cancel a mission, and until when?**
- Lead or Director, before Completed
- Lead before approval, Director after
- Director only
- **Other (typed answer): "lead can cancel before active"** ✅

**Q23. What should the matcher return when no team satisfies every requirement?**
- **Best partial team + gaps** — proposes the closest team and lists each unmet requirement with the reason ✅
- No team, reasons only

**Q24. Should the platform keep an audit log?**
- **Yes, all state changes** — lifecycle transitions, assignments, role and settings changes; Directors can read it ✅
- Lifecycle and approvals only
- No audit log

### Round 7 — Follow-up on cancellation

> One of those answers needs a follow-up, plus one gap it exposed.

**Q25. You said Leads can cancel before a mission goes Active. What about Directors, and Active missions?**
- Directors can cancel anything
- **Only Leads, never once Active** — Directors don't cancel; Active missions always run to Completed ✅
- Directors too, before Active

**Q26. Can any Lead cancel (and edit) any mission, or only the missions they lead?**
- **Only their own missions** — other Leads can view but not change it ✅
- Any mission in the org
- Own, with transfer

**Q27. Which assignments block a crew member from being matched to another mission with overlapping dates, and count toward their mission cap?**
- **Pending approval and later** — Crewing assignments are tentative; submitting for approval locks the crew ✅
- Approved and Active only
- Any assignment, even Crewing

---

## 3. Claude — writing the document

> I have what I need. I'll write the design document as a Markdown file for the repo and publish it as a shareable document.

*[Claude wrote `DESIGN.md` (22 sections), tightened three passages during review (the expiry rule for missions left pending past their start date, the effect of lowering the workload cap, and hold release on completion), built a styled web page from the same content with a section index, checked it at desktop and phone widths, published it as a private shareable page, and attached `DESIGN.md`.]*

### Claude — reply on delivery

> I've written the design document and published it as a page. The same content is attached as `DESIGN.md` for your repo.
>
> It's built on the answers you gave. The main points:
>
> - **Stack and access:** TypeScript and PostgreSQL. Each organisation's data is separated both in the application and by database rules (row-level security). Users log in with email and password.
> - **Lifecycle:** Draft → Crewing → Pending approval → Approved → Active → Completed, plus Cancelled.
> - **Double-booking:** a crew member can't be on two missions with overlapping dates. The database blocks this, so two missions submitted at the same moment can't both claim the same person.
> - **Matcher:** it picks the whole team at once. It covers the required skills first, then spreads missions fairly across the crew, then prefers stronger skill levels. If no full team exists, it returns the best partial team and says what is stopping each unmet requirement.
>
> **Nine things weren't covered by your answers.** You asked me not to assume, so I haven't treated these as settled. Section 4 lists them as open questions, each with a proposed answer, and they're marked OQ-1 to OQ-9 wherever they appear:
>
> 1. Can crew mark themselves unavailable during a mission they're already committed to? I proposed no.
> 2. What is the default limit on upcoming missions per crew member? I proposed 3, with each organisation able to change it.
> 3. Can crew see who else is on their missions? I proposed no.
> 4. Can a user be deactivated while they have missions in progress? I proposed no.
> 5. Can crew change their skill levels while committed to a mission? I proposed yes, affecting future matching only.
> 6. Can a Lead take a mission back out of approval themselves? I proposed yes.
> 7. Who manages the skill list? I proposed Directors.
> 8. When are crew told about an assignment? I proposed when the mission is approved.
> 9. Whose time zone decides when missions start and end? I proposed the organisation's own time zone.
>
> Tell me which of these to change and I'll update both versions.
>
> The page is private until you share it from its Share menu.

---

## 4. User

> write our entire chat to a markdown file

## 5. Claude

*[Claude wrote this file, `CHAT_TRANSCRIPT.md`.]*
