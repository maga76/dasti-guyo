"""practice results

Revision ID: b41c2d7e9a10
Revises: e7d5b6007a95
Create Date: 2026-10-25 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b41c2d7e9a10'
down_revision: Union[str, None] = 'e7d5b6007a95'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('practice_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('score', sa.Integer(), nullable=False),
    sa.Column('correct', sa.Integer(), nullable=False),
    sa.Column('total', sa.Integer(), nullable=False),
    sa.Column('rounds', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('practice_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_practice_results_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('practice_results', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_practice_results_user_id'))

    op.drop_table('practice_results')
