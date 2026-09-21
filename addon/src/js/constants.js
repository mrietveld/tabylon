
export const MANIFEST = Object.freeze(browser.runtime.getManifest());
export const STG_BASE_URL = browser.runtime.getURL('');
export const BROWSER = await browser.runtime.getBrowserInfo();
export const PLATFORM = await browser.runtime.getPlatformInfo();

export const BROWSER_FULL_NAME = `${BROWSER?.name} ${BROWSER?.vendor}`;
export const IS_WINDOWS = PLATFORM.os === browser.runtime.PlatformOs.WIN;
export const IS_MAC = PLATFORM.os === browser.runtime.PlatformOs.MAC;

export const IS_BACKGROUND_PAGE = self.location.pathname.includes('background');

export const DEBUG = Object.freeze({
    MANUAL: 'manual',
    AUTO: 'auto',
});

export const MAX_URL_LENGTH = 1048572; // bytes of the serialized url, all ASCII, so also its characters: the last length accepted for the stub page shape, docs/CREATE-TABS-BEHAVIOR.md §20

export const ACTIVE_SYMBOL = '〇';
export const DISCARDED_SYMBOL = '✱';
export const STICKY_SYMBOL = '📌';

export const DEFAULT_COOKIE_STORE_ID_FIREFOX = 'firefox-default';
export const DEFAULT_COOKIE_STORE_ID = {
    'IceCat GNU': 'icecat-default',
}[BROWSER_FULL_NAME] ?? DEFAULT_COOKIE_STORE_ID_FIREFOX;

export const TEMPORARY_CONTAINER = 'temporary-container';
export const TEMPORARY_CONTAINER_ICON = 'chill';

export const MOZILLA_API = Object.freeze({
    get BASE_URL() {
        return 'https://addons.mozilla.org/api/v5/';
    },
    get ADDON() {
        return this.BASE_URL + 'addons/addon/{id}/';
    },
});

export const HOST = Object.freeze({
    NAME: 'simple_tab_groups_host',
    VERSION: '1.0',
});

export const INTERVAL_KEY = Object.freeze({
    minutes: 'minutes',
    hours: 'hours',
    days: 'days',
});

export const STG_HELP_PAGES = Object.freeze([
    'welcome',
    'extensions-that-conflict-with-stg',
    'open-in-container',
    'how-to-github-gist',
    'stg-unsupported-url',
    'stg-debug',
    'db-error-reinstall',
]);

export const PAGES = Object.freeze({
    POPUP: browser.runtime.getURL('popup/popup.html'),
    MANAGE: browser.runtime.getURL('manage/manage.html'),
    ORGANIZE: browser.runtime.getURL('organize/organize.html'),
    SETTINGS: browser.runtime.getURL('options/options.html'),
    HELP: {
        WELCOME: browser.runtime.getURL('help/welcome.html'),
        CONFLICTED_EXTENSIONS: browser.runtime.getURL('help/extensions-that-conflict-with-stg.html'),
        OPEN_IN_CONTAINER: browser.runtime.getURL('help/open-in-container.html'),
        HOWTO_GITHUB_GIST: browser.runtime.getURL('help/how-to-github-gist.html'),
        UNSUPPORTED_URL: browser.runtime.getURL('help/stg-unsupported-url.html'),
        DUMMY: browser.runtime.getURL('help/dummy.html'),
        DEBUG: browser.runtime.getURL('help/stg-debug.html'),
        REINSTALL: browser.runtime.getURL('help/db-error-reinstall.html'),
    },
    DOC: {
        UNSUPPORTED_URL: 'https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Content_scripts',
    },
    isPopup: location.href === MANIFEST.browser_action.default_popup,
    isSidebar: location.href === MANIFEST.sidebar_action.default_panel,
    get isManage() {
        return location.href.startsWith(PAGES.MANAGE);
    },
    isOptions: location.href.startsWith(MANIFEST.options_ui.page),
});

// permission "<all_urls>" need for tab thumbnails and webRequestBlocking
export const PERMISSIONS = Object.freeze({
    BOOKMARKS: {
        permissions: ['bookmarks'],
    },
    BROWSER_SETTINGS: {
        permissions: ['browserSettings'],
    },
});

export const BROWSER_SETTINGS_SCHEME = Object.freeze({
    newTabPosition: {
        title: 'browserSettingNewTabPosition',
        values: ['afterCurrent', 'relatedAfterCurrent', 'atEnd'],
    },
    verticalTabs: {
        title: 'browserSettingVerticalTabs',
        type: Boolean,
    },
});

export const AUTO_BACKUP_LOCATIONS = Object.freeze({
    DOWNLOADS: 'downloads',
});

const GROUP_ICON_VIEW_TYPES = {
    'main-squares': 'icon',
    'circle': 'circle',
    'squares': 'squares',
    'old-tab-groups': 'old-tab-groups',
    'title': 'text',
};
await Promise.all(Object.entries(GROUP_ICON_VIEW_TYPES).map(async ([key, icon]) => {
    GROUP_ICON_VIEW_TYPES[key] = await fetch(`/icons/${icon}.svg`).then(response => response.text());
}))
Object.freeze(GROUP_ICON_VIEW_TYPES);
export { GROUP_ICON_VIEW_TYPES };

export const DEFAULT_GROUP_ICON_VIEW_TYPE = Object.keys(GROUP_ICON_VIEW_TYPES)[0];

export const DEFAULT_BOOKMARKS_PARENTS = Object.freeze([
    'toolbar_____',
    'menu________',
    'unfiled_____',
]);

export const HOTKEY_ACTIONS = Object.freeze([
    'load-next-group',
    'load-prev-group',
    'load-next-unloaded-group',
    'load-prev-unloaded-group',
    'load-next-non-empty-group',
    'load-prev-non-empty-group',
    'load-history-next-group',
    'load-history-prev-group',
    'load-first-group',
    'load-last-group',
    'load-custom-group',
    'add-new-group',
    'rename-group',
    'delete-current-group',
    'open-manage-groups',
    'move-selected-tabs-to-custom-group',
    'discard-group',
    'discard-other-groups',
    'reload-all-tabs-in-current-group',
    'start-cloud-sync',
]);

export const HOTKEY_ACTIONS_WITH_CUSTOM_GROUP = Object.freeze([
    'load-custom-group',
    'move-selected-tabs-to-custom-group',
    'discard-group',
    'rename-group',
]);

export const POPUP_SETTINGS_MENU_ITEMS = Object.freeze([
    {
        key: 'showArchivedGroups',
        optionsCheckbox: true,
    }, {
        key: 'closePopupAfterChangeGroup',
        optionsCheckbox: true,
    }, {
        key: 'closePopupAfterSelectTab',
        optionsCheckbox: true,
    }, {
        key: 'openGroupAfterChange',
        optionsCheckbox: true,
    }, {
        key: 'showExtendGroupsPopupWithActiveTabs',
        optionsCheckbox: true,
    }, {
        key: 'fullPopupWidth',
        optionsCheckbox: true,
    }, {
        key: 'alwaysAskNewGroupName',
        optionsCheckbox: true,
    }, {
        key: 'hr',
    }, {
        key: 'hr',
    }, {
        key: 'aboutAddon',
        sendMessage: ['open-options-page', {
            section: 'about',
        }],
        title: 'aboutExtension',
        icon: 'info',
        closePopup: true,
    },
]);

/* export const TREE_TABS_EXTENSIONS = Object.freeze([
    'treestyletab@piro.sakura.ne.jp',
    '{8d808887-ed13-4931-9f5a-4c0bff979a5a}',
]); */

export const CONFLICTED_EXTENSIONS_FOR_REOPEN_TAB_IN_CONTAINER = Object.freeze([
    '@testpilot-containers', // https://addons.mozilla.org/firefox/addon/multi-account-containers/
    '@contain-google', // https://addons.mozilla.org/firefox/addon/google-container/
    '@contain-facebook', // https://addons.mozilla.org/firefox/addon/facebook-container/
    '@contain-amzn', // https://addons.mozilla.org/firefox/addon/contain-amazon/
    '@contain-twitter', // https://addons.mozilla.org/firefox/addon/twitter-container/
    '@contain-youtube', // https://addons.mozilla.org/firefox/addon/youtube-container/
    '@containing-reddit', // https://addons.mozilla.org/firefox/addon/contain-reddit/
    'containerise@kinte.sh', // https://addons.mozilla.org/firefox/addon/containerise/
]);

export const CONFLICTED_EXTENSIONS = Object.freeze([
    'tab_open_close_control@felix-kolbe.de', // https://addons.mozilla.org/firefox/addon/tab-open-close-control/
    'extension@one-tab.com', // https://addons.mozilla.org/firefox/addon/onetab/
    '{dcdaadfa-21f1-4853-9b34-aad681fff6f3}', // https://addons.mozilla.org/firefox/addon/tiled-tab-groups/
    'panorama-tab-groups@example.com', // https://addons.mozilla.org/firefox/addon/panorama-tab-groups/
    '{60e27487-c779-464c-8698-ad481b718d5f}', // https://addons.mozilla.org/firefox/addon/panorama-view/
    'panorama@nyordanov.com', // https://addons.mozilla.org/firefox/addon/basic-panorama/
    'firefox-addon@workona.com', // https://addons.mozilla.org/firefox/addon/workona/
    'tab-stash@condordes.net', // https://addons.mozilla.org/firefox/addon/tab-stash/
    'tab-array@menhera.org', // https://addons.mozilla.org/firefox/addon/container-tab-groups/
    '{3c078156-979c-498b-8990-85f7987dd929}', // https://addons.mozilla.org/firefox/addon/sidebery/
    'tab_group_window@crossblade.her.jp', // https://addons.mozilla.org/firefox/addon/tab-group-window/
    'power-tabs@rapptz-addons.com', // https://addons.mozilla.org/firefox/addon/power-tabs/
    '{644e8eb0-c710-47e9-b81c-5dd69bfcf86b}', // https://addons.mozilla.org/firefox/addon/tabs-aside/
    'sync-tab-groups@eric.masseran', // Sync Tab Groups
    'Tab-Session-Manager@sienori', // https://addons.mozilla.org/firefox/addon/tab-session-manager/
]);

export const DEFAULT_OPTIONS = Object.freeze({
    groups: [],

    // options

    /* changed group keys with the exception: id, tabs */
    defaultGroupProps: {},

    closePopupAfterChangeGroup: true,
    closePopupAfterSelectTab: false,
    openGroupAfterChange: false,
    showArchivedGroups: true,
    alwaysAskNewGroupName: true,
    createNewGroupWhenOpenNewWindow: false,
    cloneSubGroupsWhenMovingTabs: false,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupArchiving: true,
    showConfirmDialogBeforeGroupDelete: true,
    showNotificationAfterGroupDelete: true,
    showContextMenuOnTabs: true,
    showContextMenuOnLinks: true,
    defaultBookmarksParent: DEFAULT_BOOKMARKS_PARENTS[0],
    showExtendGroupsPopupWithActiveTabs: false,
    showTabsWithThumbnailsInManageGroups: false,
    fullPopupWidth: false,
    temporaryContainerTitle: browser.i18n.getMessage('temporaryContainerTitle'),
    organizerServiceUrl: 'http://127.0.0.1:5050',
    organizerMinimumGroupSize: 5,
    organizerDefaultScope: 'ungrouped-current-window',

    contextMenuTab: [
        'open-in-new-window',
        'reload',
        'discard',
        'remove',
        'update-thumbnail',
        'set-group-icon',
        'move-tab-to-group',
    ],
    contextMenuGroup: [
        'open-in-new-window',
        'sort-asc',
        'sort-desc',
        'discard',
        'discard-other',
        'export-to-bookmarks',
        'unload',
        'archive',
        'rename',
        'reload-all-tabs',
    ],

    autoBackupEnable: true,
    autoBackupIntervalKey: INTERVAL_KEY.days, // minutes, hours, days
    autoBackupIntervalValue: 1,
    autoBackupLocation: AUTO_BACKUP_LOCATIONS.DOWNLOADS,
    autoBackupFilePath: 'STG-backups-FF-{ff-version}/STG-backup {date-full} {time-short}',
    autoBackupIncludeTabThumbnails: true,
    autoBackupIncludeTabFavIcons: true,

    colorScheme: 'auto', // auto, light, dark

    browserSettings: {},

    hotkeys: [
        {
            value: `${IS_MAC ? 'Mac' : ''}Ctrl+Backquote`,
            action: 'load-next-group',
            groupId: null,
        }, {
            value: `${IS_MAC ? 'Mac' : ''}Ctrl+Shift+Backquote`,
            action: 'load-prev-group',
            groupId: null,
        },
    ],
});

const DEFAULT_OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

export const ONLY_BOOL_OPTION_KEYS = Object.freeze(DEFAULT_OPTION_KEYS.filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]));

export const NON_OPTION_KEYS = Object.freeze(['version', 'groups']);

export const ALL_OPTION_KEYS = Object.freeze(DEFAULT_OPTION_KEYS.filter(key => !NON_OPTION_KEYS.includes(key)));

export const ON_UPDATED_TAB_PROPERTIES = Object.freeze([ // browser.tabs not defined into web page scripts
    browser.tabs?.UpdatePropertyName.TITLE, // for cache
    browser.tabs?.UpdatePropertyName.STATUS, // for check update url and thumbnail
    browser.tabs?.UpdatePropertyName.URL,
    browser.tabs?.UpdatePropertyName.FAVICONURL, // for session
    browser.tabs?.UpdatePropertyName.HIDDEN,
    browser.tabs?.UpdatePropertyName.PINNED,
    browser.tabs?.UpdatePropertyName.DISCARDED,
    browser.tabs?.UpdatePropertyName.AUDIBLE,
    browser.tabs?.UpdatePropertyName.MUTEDINFO,
]);

export const MODULES = Object.freeze({
    BACKGROUND: 'Background',
    MANAGE: 'Manage',
    POPUP: 'Popup',
    SIDEBAR: 'Sidebar',
    OPTIONS: 'Options',
    GROUPS: 'Groups',
    BOOKMARKS: 'Bookmarks',
    EXTENSIONS: 'Extensions',
    CLOUD: 'Cloud',
    LOGGER: 'Logger',
});
