# Tabylon and Organizer Architecture

[Tabylon source repository](https://github.com/mrietveld/tabylon)

Tabylon is the current Firefox add-on in this repository. It began as a fork of the **Simple Tab Groups** add-on; references to Simple Tab Groups below describe that project’s history, not the current add-on name.

## Overview

Tabylon includes the Firefox add-on and a local Python backend. The add-on collects the tabs selected for organization, sends their titles and URLs to the configured backend, displays the proposed groups for review, and applies only the plan the user approves.

The backend generates and validates grouping plans. It does not control Firefox or move tabs. Tabylon owns all browser-side changes.

## Organizer flow

1. The user opens Smart Organizer in Tabylon and chooses a scope.
2. Tabylon collects eligible tabs and sends their titles and URLs to the configured HTTP(S) service (by default, `http://127.0.0.1:5050`).
3. The Python backend returns a grouping plan.
4. Tabylon lets the user review and edit the plan.
5. On approval, Tabylon checks that assigned tabs have not changed since the plan was created, then creates groups and moves those tabs.

The organizer page uses Tabylon’s internal runtime messaging. It does not expose an external-extension messaging interface.

## Relevant code

- Organizer workflow, settings, and backend client: `addon/src/js/organizer/`
- Organizer review interface: `addon/src/organize/Organize.vue`
- Browser-side plan application: `addon/src/js/organizer/apply-plan.js`
- Add-on background script: `addon/src/background.js`
- Python API and grouping services: `backend/app/`

## Data and safety

Tab titles and URLs in the chosen scope are sent to the configured organizer service. Users should configure a service they trust. No tabs are moved until the user approves a plan. Before applying it, Tabylon checks the assigned tabs against the captured state; if the tabs have changed, the plan must be regenerated.
