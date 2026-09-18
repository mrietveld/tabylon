import '/js/wait-background.js';
import Vue from 'vue';

import Logger, {errorEventHandler} from '/js/logger.js';
import globalMixin from '/js/mixins/global.mixin.js';
import Organize from './Organize.vue';

window.logger = new Logger('Organize');
Vue.config.errorHandler = errorEventHandler.bind(window.logger);
Vue.mixin(globalMixin);

new Vue({
    el: '#stg-organize',
    render: h => h(Organize),
});
