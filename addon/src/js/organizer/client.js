import {validateGroupingPlan} from './contracts.js';

const HEALTH_SERVICE_NAME = 'tab-organizer-backend';
const GROUPING_BASIS = 'common theme or task';

const ERROR_MESSAGES = Object.freeze({
    'invalid-service-url': 'The organizer service URL must use HTTP or HTTPS.',
    'network-error': 'The organizer service could not be reached.',
    'http-error': 'The organizer service returned an HTTP error.',
    'malformed-json': 'The organizer service returned malformed JSON.',
    'invalid-health-response': 'The organizer service returned an unexpected health response.',
    'invalid-plan-response': 'The organizer service returned an invalid grouping plan.',
});

export class OrganizerClientError extends Error {
    constructor(code, {status = null, cause} = {}) {
        super(ERROR_MESSAGES[code], {cause});
        this.name = 'OrganizerClientError';
        this.code = code;
        this.status = status;
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            status: this.status,
        };
    }
}

function serviceEndpoint(serviceUrl, path) {
    let baseUrl;
    try {
        baseUrl = new URL(serviceUrl);
    } catch (cause) {
        throw new OrganizerClientError('invalid-service-url', {cause});
    }

    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
        throw new OrganizerClientError('invalid-service-url');
    }

    return new URL(`/${path}`, baseUrl).href;
}

async function requestJson(url, init, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, init);
    } catch (cause) {
        throw new OrganizerClientError('network-error', {cause});
    }

    if (!response.ok) {
        throw new OrganizerClientError('http-error', {status: response.status});
    }

    try {
        return await response.json();
    } catch (cause) {
        throw new OrganizerClientError('malformed-json', {cause});
    }
}

export async function checkService(serviceUrl, {fetchImpl = globalThis.fetch} = {}) {
    const url = serviceEndpoint(serviceUrl, 'health');
    const health = await requestJson(url, {method: 'GET'}, fetchImpl);

    if (health?.status !== 'ok' || health?.service !== HEALTH_SERVICE_NAME) {
        throw new OrganizerClientError('invalid-health-response');
    }

    return health;
}

function wireTab(tab) {
    return {
        tabId: tab.tabId,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active === true,
        pinned: tab.pinned === true,
        audible: tab.audible === true,
        discarded: tab.discarded === true,
    };
}

function wireRequest(snapshot) {
    return {
        requestId: snapshot.requestId,
        capturedAt: snapshot.capturedAt,
        constraints: {
            minimumGroupSize: snapshot.request.minimumGroupSize,
            groupingBasis: GROUPING_BASIS,
        },
        tabs: snapshot.tabs.map(wireTab),
    };
}

export async function generateGroupingPlan(serviceUrl, snapshot, {fetchImpl = globalThis.fetch} = {}) {
    const url = serviceEndpoint(serviceUrl, 'api/groupings/generate');
    const plan = await requestJson(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(wireRequest(snapshot)),
    }, fetchImpl);

    try {
        return validateGroupingPlan(plan, snapshot);
    } catch (cause) {
        throw new OrganizerClientError('invalid-plan-response', {cause});
    }
}
