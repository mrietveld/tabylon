<script>
import {
    moveDraftTabToGroup,
    moveDraftTabToUnassigned,
    removeDraftGroup,
} from '/js/organizer/draft.js';
import optionsMixin from '/js/mixins/options.mixin.js';
import {parseOrganizerQuery} from './query.js';

const SCOPE_OPTIONS = Object.freeze([
    {
        value: 'ungrouped-current-window',
        label: 'Ungrouped tabs in this window',
        description: 'Organize tabs that are not already in an STG group.',
    },
    {
        value: 'current-group',
        label: 'Current group',
        description: 'Reorganize the tabs in the active STG group.',
    },
    {
        value: 'selected',
        label: 'Selected tabs',
        description: 'Organize the tabs selected before opening this page.',
    },
    {
        value: 'all',
        label: 'All tabs',
        description: 'Organize eligible tabs from every browser window.',
    },
]);
const WORKFLOW_PHASES = new Set(['choose', 'generate', 'review', 'apply']);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default {
    name: 'Organize',
    mixins: [optionsMixin],
    data() {
        const query = parseOrganizerQuery(window.location.search);
        return {
            scopeOptions: SCOPE_OPTIONS,
            scope: query.scope,
            selectedTabIds: query.selectedTabIds,
            state: null,
            draft: null,
            isLoading: true,
            busyAction: null,
            isSaving: false,
            draggedTabId: null,
            pageError: false,
            editError: '',
        };
    },
    computed: {
        screen() {
            if (this.isLoading) {
                return 'loading';
            }
            if (this.busyAction === 'generate') {
                return 'generate';
            }
            if (this.busyAction === 'apply') {
                return 'apply';
            }
            if (this.pageError || !this.state) {
                return 'error';
            }
            if (this.state.phase === 'choose') {
                return 'choose';
            }
            if (this.state.phase === 'generate') {
                return this.state.status === 'error' ? 'error' : 'generate';
            }
            if (this.state.phase === 'review') {
                return 'review';
            }
            if (this.state.phase === 'apply') {
                return this.state.status === 'complete' ? 'success' : 'error';
            }
            return 'error';
        },
        selectedScopeAvailable() {
            return this.selectedTabIds.length > 0;
        },
        canStart() {
            return !this.busyAction && (this.scope !== 'selected' || this.selectedScopeAvailable);
        },
        tabById() {
            return new Map((this.draft?.snapshot.tabs ?? []).map(tab => [tab.tabId, tab]));
        },
        reviewGroups() {
            return this.draft?.groups ?? [];
        },
        unassignedTabs() {
            return (this.draft?.unassignedTabIds ?? [])
                .map(tabId => this.tabById.get(tabId))
                .filter(Boolean);
        },
        skippedEntries() {
            return this.draft?.snapshot.skipped ?? [];
        },
        canApply() {
            return !this.isSaving && !this.busyAction && this.reviewGroups.length > 0 &&
                this.reviewGroups.every(group => group.name.trim());
        },
        isApplyError() {
            return this.state?.phase === 'apply' && this.state?.status === 'error';
        },
        applyResult() {
            return this.state?.applyResult ?? null;
        },
        retainedGroupIds() {
            const ids = [
                ...(this.applyResult?.retainedGroups ?? []).map(group => group.groupId),
                ...(this.applyResult?.failure?.retainedGroupIds ?? []),
            ].filter(id => typeof id === 'string' && id);
            return [...new Set(ids)];
        },
        rollbackUncertain() {
            return this.applyResult?.failure?.groupCreationUncertain === true ||
                (this.applyResult?.rollbackFailures?.length ?? 0) > 0 ||
                (this.applyResult?.retainedGroups ?? []).some(group => group.remainingTabIds === null);
        },
        changedTabCount() {
            const preflight = this.applyResult?.preflight;
            if (!preflight || preflight.ok) {
                return 0;
            }
            return new Set([
                ...preflight.missingTabIds,
                ...preflight.urlChangedTabIds,
                ...preflight.windowChangedTabIds,
                ...preflight.groupChangedTabIds,
            ]).size;
        },
        errorMessage() {
            if (this.pageError) {
                return 'The organizer page could not contact the extension background service.';
            }
            if (this.isApplyError) {
                if (this.applyResult?.failure?.stage === 'preflight') {
                    return 'Some tabs changed after this plan was generated. Generate a fresh plan before trying again.';
                }
                return 'The plan could not be applied completely. Review the recovery details below before continuing.';
            }
            return this.state?.error?.message || 'The organizer could not generate a plan.';
        },
    },
    async mounted() {
        this.isLoading = true;
        this.pageError = false;
        try {
            await this.optionsLoadPromise;
            const query = parseOrganizerQuery(window.location.search, this.options.organizerDefaultScope);
            this.scope = query.scope;
            this.selectedTabIds = query.selectedTabIds;
            await this.loadState();
        } catch (_error) {
            this.pageError = true;
        } finally {
            this.isLoading = false;
        }
    },
    methods: {
        setState(state) {
            if (!state || !WORKFLOW_PHASES.has(state.phase)) {
                throw new TypeError('Organizer returned an invalid workflow state');
            }
            this.state = state;
            this.draft = clone(state?.draft);
            this.editError = '';
        },
        async loadState() {
            const state = await this.sendMessageModule('Organizer.getState');
            this.setState(state);
            if (state?.params?.scope && state.phase !== 'choose') {
                this.scope = state.params.scope;
            }
        },
        async start() {
            if (!this.canStart) {
                return;
            }
            this.busyAction = 'generate';
            this.pageError = false;
            try {
                this.setState(await this.sendMessageModule('Organizer.start', {
                    scope: this.scope,
                    selectedTabIds: this.scope === 'selected' ? this.selectedTabIds : [],
                }));
            } catch (_error) {
                this.pageError = true;
            } finally {
                this.busyAction = null;
            }
        },
        async regenerate() {
            this.busyAction = 'generate';
            this.pageError = false;
            try {
                this.setState(await this.sendMessageModule('Organizer.refresh'));
            } catch (_error) {
                this.pageError = true;
            } finally {
                this.busyAction = null;
            }
        },
        async cancel() {
            this.busyAction = 'clear';
            this.pageError = false;
            try {
                this.setState(await this.sendMessageModule('Organizer.clear'));
                const query = parseOrganizerQuery(window.location.search, this.options.organizerDefaultScope);
                this.scope = query.scope;
                this.selectedTabIds = query.selectedTabIds;
            } catch (_error) {
                this.pageError = true;
            } finally {
                this.busyAction = null;
            }
        },
        async persistDraft() {
            if (!this.draft || this.draft.groups.some(group => !group.name.trim())) {
                this.editError = 'Every proposed group needs a name.';
                return false;
            }
            this.isSaving = true;
            this.editError = '';
            try {
                this.setState(await this.sendMessageModule('Organizer.saveDraft', clone(this.draft)));
                return true;
            } catch (_error) {
                this.editError = 'The draft could not be saved. Reload the page and try again.';
                return false;
            } finally {
                this.isSaving = false;
            }
        },
        async moveTabToGroup(event, groupId) {
            event.preventDefault();
            const tabId = this.draggedTabId ?? Number(event.dataTransfer?.getData('text/plain'));
            if (!Number.isSafeInteger(tabId) || !this.draft) {
                return;
            }
            try {
                this.draft = moveDraftTabToGroup(this.draft, tabId, groupId);
                await this.persistDraft();
            } catch (_error) {
                this.editError = 'That tab could not be moved.';
            } finally {
                this.draggedTabId = null;
            }
        },
        async moveTabToUnassigned(event) {
            event.preventDefault();
            const tabId = this.draggedTabId ?? Number(event.dataTransfer?.getData('text/plain'));
            if (!Number.isSafeInteger(tabId) || !this.draft) {
                return;
            }
            try {
                this.draft = moveDraftTabToUnassigned(this.draft, tabId);
                await this.persistDraft();
            } catch (_error) {
                this.editError = 'That tab could not be moved.';
            } finally {
                this.draggedTabId = null;
            }
        },
        beginDrag(event, tabId) {
            this.draggedTabId = tabId;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(tabId));
        },
        endDrag() {
            this.draggedTabId = null;
        },
        async removeGroup(groupId) {
            if (!this.draft) {
                return;
            }
            try {
                this.draft = removeDraftGroup(this.draft, groupId);
                await this.persistDraft();
            } catch (_error) {
                this.editError = 'That group could not be removed.';
            }
        },
        async applyPlan() {
            if (!this.canApply || !await this.persistDraft()) {
                return;
            }
            this.busyAction = 'apply';
            this.pageError = false;
            try {
                const result = await this.sendMessageModule('Organizer.apply');
                if (typeof result?.success !== 'boolean') {
                    throw new TypeError('Organizer returned an invalid apply result');
                }
                this.setState(await this.sendMessageModule('Organizer.getState'));
            } catch (_error) {
                this.pageError = true;
            } finally {
                this.busyAction = null;
            }
        },
        skippedReason(reason) {
            return {
                pinned: 'Pinned tab',
                unsupported: 'Unsupported tab',
            }[reason] ?? 'Not eligible';
        },
        groupTabs(group) {
            return group.tabIds.map(tabId => this.tabById.get(tabId)).filter(Boolean);
        },
    },
};
</script>

<template>
    <main class="organizer-page">
        <header class="organizer-header">
            <div class="organizer-heading">
                <img class="organizer-logo" src="/icons/sparkles.svg" alt="">
                <div>
                    <p class="eyebrow">Simple Tab Groups</p>
                    <h1 class="title is-3 mb-1">Smart Organizer</h1>
                    <p class="has-text-grey">Turn related tabs into a clear set of groups.</p>
                </div>
            </div>
        </header>

        <section v-if="screen === 'loading' || screen === 'generate' || screen === 'apply'"
                 class="organizer-card status-card has-text-centered" aria-live="polite" aria-busy="true">
            <span class="loader organizer-loader" aria-hidden="true"></span>
            <h2 v-if="screen === 'apply'" class="title is-4">Applying your groups</h2>
            <h2 v-else-if="screen === 'generate'" class="title is-4">Building a grouping plan</h2>
            <h2 v-else class="title is-4">Loading Smart Organizer</h2>
            <p v-if="screen === 'apply'">Keep this page open while tabs are moved.</p>
            <p v-else-if="screen === 'generate'">The organizer is finding useful themes across your tabs.</p>
            <p v-else>Restoring your organizer session.</p>
        </section>

        <section v-else-if="screen === 'choose'" class="organizer-card choose-card">
            <div class="section-heading">
                <div>
                    <p class="step-label">Step 1</p>
                    <h2 class="title is-4 mb-2">Choose which tabs to organize</h2>
                    <p class="has-text-grey">Pinned and unsupported tabs are left untouched.</p>
                </div>
            </div>

            <fieldset class="scope-list">
                <legend class="is-sr-only">Tabs to organize</legend>
                <label v-for="option in scopeOptions" :key="option.value"
                       class="scope-option" :class="{'is-disabled': option.value === 'selected' && !selectedScopeAvailable}">
                    <input v-model="scope" type="radio" name="organizer-scope" :value="option.value"
                           :disabled="option.value === 'selected' && !selectedScopeAvailable">
                    <span>
                        <strong v-text="option.label"></strong>
                        <small v-text="option.description"></small>
                        <small v-if="option.value === 'selected' && selectedScopeAvailable" class="has-text-info"
                               v-text="`${selectedTabIds.length} selected tab${selectedTabIds.length === 1 ? '' : 's'}`"></small>
                    </span>
                </label>
            </fieldset>

            <div class="actions-row">
                <button class="button is-info" type="button" :disabled="!canStart" @click="start">
                    Generate plan
                </button>
            </div>
        </section>

        <template v-else-if="screen === 'review'">
            <section class="organizer-card review-intro">
                <div class="section-heading">
                    <div>
                        <p class="step-label">Step 2</p>
                        <h2 class="title is-4 mb-2">Review the proposed groups</h2>
                        <p v-if="draft.summary" class="review-summary" v-text="draft.summary"></p>
                    </div>
                    <span class="tag is-info is-light" v-text="`${reviewGroups.length} proposed group${reviewGroups.length === 1 ? '' : 's'}`"></span>
                </div>

                <div v-if="draft.warnings.length" class="notification is-warning is-light mt-4">
                    <h3 class="has-text-weight-semibold mb-2">Organizer warnings</h3>
                    <ul class="safe-list">
                        <li v-for="(warning, index) in draft.warnings" :key="index" v-text="warning"></li>
                    </ul>
                </div>

                <div v-if="skippedEntries.length" class="skipped-panel mt-4">
                    <h3 class="has-text-weight-semibold">Skipped tabs</h3>
                    <p class="is-size-7 has-text-grey mb-2">These tabs are not part of the plan and will not be changed.</p>
                    <ul class="skipped-list">
                        <li v-for="entry in skippedEntries" :key="`${entry.tabId}-${entry.reason}`">
                            <span v-text="`Tab ${entry.tabId}`"></span>
                            <span class="tag is-light" v-text="skippedReason(entry.reason)"></span>
                        </li>
                    </ul>
                </div>
            </section>

            <p v-if="editError" class="notification is-danger is-light" role="alert" v-text="editError"></p>

            <section class="groups-grid" aria-label="Proposed tab groups">
                <article v-for="group in reviewGroups" :key="group.id" class="group-card organizer-card"
                         @dragover.prevent @drop="moveTabToGroup($event, group.id)">
                    <div class="group-card-header">
                        <div class="field group-name-field">
                            <label class="is-sr-only" :for="`group-name-${group.id}`">Group name</label>
                            <input :id="`group-name-${group.id}`" v-model="group.name" class="input is-medium"
                                   type="text" maxlength="120" required aria-label="Group name"
                                   @change="persistDraft">
                        </div>
                        <button class="button is-light is-small remove-group" type="button"
                                :aria-label="`Remove group ${group.name}`" :disabled="isSaving"
                                @click="removeGroup(group.id)">Remove</button>
                    </div>
                    <p v-if="group.reason" class="group-reason" v-text="group.reason"></p>
                    <div class="tab-list" :class="{'is-empty': !groupTabs(group).length}">
                        <article v-for="tab in groupTabs(group)" :key="tab.tabId" class="tab-card" :draggable="!isSaving"
                                 @dragstart="beginDrag($event, tab.tabId)" @dragend="endDrag">
                            <span class="drag-handle" aria-hidden="true">⋮⋮</span>
                            <span class="tab-copy">
                                <strong v-text="tab.title"></strong>
                                <small v-text="tab.url"></small>
                            </span>
                        </article>
                        <p v-if="!groupTabs(group).length" class="drop-hint">Drop tabs here</p>
                    </div>
                </article>
            </section>

            <section class="organizer-card unassigned-card" @dragover.prevent @drop="moveTabToUnassigned">
                <div class="section-heading compact">
                    <div>
                        <h2 class="title is-5 mb-1">Unassigned tabs</h2>
                        <p class="is-size-7 has-text-grey">Drop tabs here to leave them outside the new groups.</p>
                    </div>
                    <span class="tag is-light" v-text="unassignedTabs.length"></span>
                </div>
                <div class="unassigned-list" :class="{'is-empty': !unassignedTabs.length}">
                    <article v-for="tab in unassignedTabs" :key="tab.tabId" class="tab-card" :draggable="!isSaving"
                             @dragstart="beginDrag($event, tab.tabId)" @dragend="endDrag">
                        <span class="drag-handle" aria-hidden="true">⋮⋮</span>
                        <span class="tab-copy">
                            <strong v-text="tab.title"></strong>
                            <small v-text="tab.url"></small>
                        </span>
                    </article>
                    <p v-if="!unassignedTabs.length" class="drop-hint">Drop a tab here to leave it unassigned</p>
                </div>
            </section>

            <footer class="review-actions organizer-card">
                <div class="secondary-actions">
                    <button class="button is-light" type="button" :disabled="isSaving" @click="cancel">Cancel</button>
                    <button class="button is-light" type="button" :disabled="isSaving" @click="regenerate">Regenerate</button>
                </div>
                <button class="button is-info" type="button" :disabled="!canApply" @click="applyPlan">
                    Apply groups
                </button>
            </footer>
        </template>

        <section v-else-if="screen === 'success'" class="organizer-card status-card has-text-centered" aria-live="polite">
            <div class="success-mark" aria-hidden="true">✓</div>
            <p class="step-label">Complete</p>
            <h2 class="title is-3">Your tabs are organized</h2>
            <p v-text="`${applyResult?.createdGroups?.length ?? 0} group${applyResult?.createdGroups?.length === 1 ? '' : 's'} created successfully.`"></p>
            <button class="button is-info mt-5" type="button" @click="cancel">Organize more tabs</button>
        </section>

        <section v-else class="organizer-card error-card" role="alert">
            <p class="step-label has-text-danger">Action needed</p>
            <h2 class="title is-4">{{ isApplyError ? 'The plan was not fully applied' : 'Smart Organizer hit a problem' }}</h2>
            <p v-text="errorMessage"></p>

            <div v-if="isApplyError" class="recovery-details mt-5">
                <p v-if="changedTabCount" v-text="`${changedTabCount} tab${changedTabCount === 1 ? '' : 's'} changed since the plan was created.`"></p>
                <div v-if="retainedGroupIds.length" class="notification is-warning is-light">
                    <p class="has-text-weight-semibold mb-2">Groups that may still exist</p>
                    <ul class="safe-list">
                        <li v-for="groupId in retainedGroupIds" :key="groupId" v-text="groupId"></li>
                    </ul>
                </div>
                <p v-if="rollbackUncertain" class="notification is-warning is-light">
                    Automatic recovery could not be verified completely. Check your groups and tabs before trying again.
                </p>
            </div>

            <div class="actions-row mt-5">
                <button v-if="!pageError" class="button is-info" type="button" @click="regenerate">Try a fresh plan</button>
                <button class="button is-light" type="button" @click="cancel">Cancel and clear</button>
            </div>
        </section>
    </main>
</template>

<style scoped>
.organizer-page {
    min-height: 100vh;
    padding: clamp(1rem, 3vw, 2.5rem);
    background:
        radial-gradient(circle at 12% 0%, hsla(var(--bulma-info-h), var(--bulma-info-s), var(--bulma-info-l), 0.13), transparent 32rem),
        var(--bulma-background);
    color: var(--bulma-text);
}

.organizer-header,
.organizer-page > section,
.organizer-page > footer,
.organizer-page > .groups-grid,
.organizer-page > p {
    width: min(1120px, 100%);
    margin-inline: auto;
}

.organizer-header {
    margin-bottom: 1.5rem;
}

.organizer-heading,
.section-heading,
.group-card-header,
.review-actions,
.actions-row,
.secondary-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
}

.organizer-heading {
    align-items: flex-start;
}

.organizer-logo {
    width: 3rem;
    height: 3rem;
    flex: none;
}

.eyebrow,
.step-label {
    margin-bottom: 0.35rem;
    color: var(--bulma-info);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.organizer-card {
    padding: clamp(1rem, 2.5vw, 1.6rem);
    border: 1px solid var(--bulma-border-weak);
    border-radius: var(--bulma-radius-large);
    background: var(--bulma-scheme-main);
    box-shadow: 0 0.5rem 1.5rem hsla(var(--bulma-scheme-h), var(--bulma-scheme-s), 4%, 0.08);
}

.section-heading {
    justify-content: space-between;
    align-items: flex-start;
}

.section-heading.compact {
    align-items: center;
}

.scope-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
    margin-block: 1.5rem;
    border: 0;
}

.scope-option {
    display: flex;
    align-items: flex-start;
    gap: 0.8rem;
    padding: 1rem;
    border: 1px solid var(--bulma-border);
    border-radius: var(--bulma-radius-medium);
    cursor: pointer;
}

.scope-option:has(input:checked) {
    border-color: var(--bulma-info);
    box-shadow: 0 0 0 2px hsla(var(--bulma-info-h), var(--bulma-info-s), var(--bulma-info-l), 0.18);
}

.scope-option.is-disabled {
    cursor: not-allowed;
    opacity: 0.55;
}

.scope-option span,
.tab-copy {
    min-width: 0;
}

.scope-option strong,
.scope-option small,
.tab-copy strong,
.tab-copy small {
    display: block;
}

.scope-option small {
    margin-top: 0.2rem;
    color: var(--bulma-text-weak);
}

.actions-row {
    justify-content: flex-end;
    flex-wrap: wrap;
}

.status-card,
.error-card {
    max-width: 720px;
    margin-top: clamp(2rem, 8vh, 6rem);
}

.organizer-loader {
    display: inline-block;
    width: 3rem;
    height: 3rem;
    margin-bottom: 1.5rem;
    border-width: 0.25rem;
}

.review-intro {
    margin-bottom: 1rem;
}

.review-summary,
.group-reason,
.safe-list,
.skipped-list {
    overflow-wrap: anywhere;
}

.safe-list {
    padding-left: 1.2rem;
    list-style: disc;
}

.skipped-panel {
    padding-top: 1rem;
    border-top: 1px solid var(--bulma-border-weak);
}

.skipped-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.skipped-list li {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
}

.groups-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
}

.group-card {
    min-width: 0;
}

.group-card-header {
    align-items: flex-start;
}

.group-name-field {
    flex: 1;
    margin-bottom: 0;
}

.remove-group {
    flex: none;
    margin-top: 0.25rem;
}

.group-reason {
    min-height: 2.5em;
    margin-block: 0.5rem 1rem;
    color: var(--bulma-text-weak);
    font-size: 0.8rem;
}

.tab-list,
.unassigned-list {
    display: grid;
    gap: 0.45rem;
    min-height: 4.2rem;
    padding: 0.45rem;
    border: 1px dashed var(--bulma-border);
    border-radius: var(--bulma-radius-medium);
    background: var(--bulma-scheme-main-bis);
}

.tab-list.is-empty,
.unassigned-list.is-empty {
    place-items: center;
}

.tab-card {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--bulma-border-weak);
    border-radius: var(--bulma-radius);
    background: var(--bulma-scheme-main);
    cursor: grab;
}

.tab-card:active {
    cursor: grabbing;
}

.drag-handle {
    flex: none;
    color: var(--bulma-text-weak);
    letter-spacing: -0.2em;
}

.tab-copy strong,
.tab-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tab-copy small,
.drop-hint {
    color: var(--bulma-text-weak);
    font-size: 0.72rem;
}

.unassigned-card {
    margin-bottom: 1rem;
}

.unassigned-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-top: 1rem;
}

.unassigned-list.is-empty {
    display: grid;
    grid-template-columns: 1fr;
}

.review-actions {
    position: sticky;
    bottom: 1rem;
    z-index: 2;
    justify-content: space-between;
    padding-block: 0.9rem;
}

.secondary-actions {
    flex-wrap: wrap;
}

.success-mark {
    display: grid;
    place-items: center;
    width: 4rem;
    height: 4rem;
    margin: 0 auto 1.2rem;
    border-radius: 50%;
    background: var(--bulma-success);
    color: var(--bulma-success-invert);
    font-size: 2rem;
    font-weight: 700;
}

.recovery-details {
    display: grid;
    gap: 1rem;
}

@media (max-width: 768px) {
    .scope-list,
    .groups-grid,
    .unassigned-list {
        grid-template-columns: 1fr;
    }

    .section-heading,
    .review-actions {
        align-items: stretch;
        flex-direction: column;
    }

    .review-actions > .button,
    .secondary-actions,
    .secondary-actions > .button {
        width: 100%;
    }
}
</style>
