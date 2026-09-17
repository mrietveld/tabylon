const obsoleteOptionKeys = [
    'syncEnable', 'syncOptionsLocation', 'syncIntervalKey', 'syncIntervalValue',
    'syncTabFavIcons', 'github' + 'GistToken', 'github' + 'GistFileName',
];

export function normalizeStandaloneOptions(data) {
    let changed = data.autoBackupLocation !== 'downloads';
    data.autoBackupLocation = 'downloads';

    for (const key of obsoleteOptionKeys) {
        if (Object.hasOwn(data, key)) {
            delete data[key];
            changed = true;
        }
    }

    data.defaultGroupProps ??= {};
    if (Object.hasOwn(data.defaultGroupProps, 'uploadToCloud')) {
        delete data.defaultGroupProps.uploadToCloud;
        changed = true;
    }

    const groups = data.groups ?? [];
    const retainedGroups = groups.filter(group => !(group.uploadToCloud === false && !Object.hasOwn(group, 'tabs')));
    if (retainedGroups.length !== groups.length) changed = true;
    data.groups = retainedGroups;

    for (const group of data.groups) {
        if (Object.hasOwn(group, 'uploadToCloud')) {
            delete group.uploadToCloud;
            changed = true;
        }
    }

    return changed;
}
