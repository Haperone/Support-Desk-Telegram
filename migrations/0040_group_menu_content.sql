-- A group's pinned menu is refreshed when its service list changes.
ALTER TABLE support_groups ADD COLUMN menu_services_json TEXT;
