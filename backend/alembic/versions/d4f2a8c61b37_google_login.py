"""google login

Revision ID: d4f2a8c61b37
Revises: c7a19f3e5d21
Create Date: 2026-10-26 18:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4f2a8c61b37'
down_revision: Union[str, None] = 'c7a19f3e5d21'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('google_id', sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column('email', sa.String(length=255), nullable=True))
        batch_op.create_index(batch_op.f('ix_users_google_id'), ['google_id'], unique=True)


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_google_id'))
        batch_op.drop_column('email')
        batch_op.drop_column('google_id')
