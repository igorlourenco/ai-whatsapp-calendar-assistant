import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_category_description.sql';
import m0002 from './0002_image_inbox.sql';
import m0003 from './0003_tasks.sql';
import m0004 from './0004_shopping.sql';
import m0005 from './0005_multi_user.sql';
import m0006 from './0006_user_icloud.sql';
import m0007 from './0007_task_nag.sql';
import m0008 from './0008_task_category.sql';
import m0009 from './0009_signup_codes.sql';
import m0010 from './0010_drop_signup_codes.sql';
import m0011 from './0011_login_requests.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004,
m0005,
m0006,
m0007,
m0008,
m0009,
m0010,
m0011
    }
  }
  